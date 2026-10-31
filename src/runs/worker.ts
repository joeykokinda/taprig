import type { AgentContext, AgentDecision } from "../agents/loop.ts";
import { runAgentLoop } from "../agents/loop.ts";
import type { DeviceAdapter } from "../core/contracts.ts";
import type { DeviceInventory } from "../daemon/server.ts";
import { runBroadcast } from "../orchestration/broadcast.ts";
import type { RunService } from "./service.ts";

export interface RunWorkerOptions {
  runs: RunService;
  devices: DeviceInventory;
  adapter: DeviceAdapter;
  decide(task: string): Decider;
}

type Decider = (context: AgentContext) => Promise<AgentDecision>;

export class RunWorker {
  readonly #active = new Map<string, Promise<void>>();
  readonly #leasedDevices = new Set<string>();
  readonly #leaseWaiters = new Set<() => void>();
  readonly #runs: RunService;
  readonly #devices: DeviceInventory;
  readonly #adapter: DeviceAdapter;
  readonly #decide: (task: string) => Decider;

  constructor(options: RunWorkerOptions) {
    this.#runs = options.runs;
    this.#devices = options.devices;
    this.#adapter = options.adapter;
    this.#decide = options.decide;
  }

  start(runId: string, deviceId?: string): void {
    if (this.#active.has(runId)) return;
    const work = this.#execute(runId, deviceId).finally(() => this.#active.delete(runId));
    this.#active.set(runId, work);
  }

  async idle(): Promise<void> {
    await Promise.all(this.#active.values());
  }

  async #execute(runId: string, requestedDeviceId?: string): Promise<void> {
    let run = this.#runs.get(runId);
    if (run?.status !== "created") return;
    run = this.#runs.record(runId, { type: "run.started", at: new Date().toISOString() });
    let leasedDeviceIds: string[] = [];
    try {
      if (run.mode === "coordinated") throw new Error("coordinated execution is not implemented");
      leasedDeviceIds =
        run.mode === "broadcast"
          ? await this.#acquireBroadcastDevices()
          : [await this.#acquireDevice(requestedDeviceId)];
      const result =
        run.mode === "broadcast"
          ? await runBroadcast({
              device: this.#adapter,
              deviceIds: leasedDeviceIds,
              decide: this.#decide(run.task),
              recover: (deviceId) =>
                runAgentLoop({
                  device: this.#adapter,
                  deviceId,
                  decide: this.#decide(run.task),
                  verifyCompletion: async () => undefined,
                }),
            })
          : await runAgentLoop({
              device: this.#adapter,
              deviceId: leasedDeviceIds[0] as string,
              decide: this.#decide(run.task),
              verifyCompletion: async () => undefined,
            });
      const at = new Date().toISOString();
      if (result.status === "completed") {
        this.#runs.checkpoint(runId, leasedDeviceIds[0] as string, {
          summary: result.evidence,
          actions: result.actions,
          devices: leasedDeviceIds,
        });
        this.#runs.record(runId, { type: "run.completed", at });
      } else if (result.status === "waiting-for-user") {
        this.#runs.question(runId, result.question);
        this.#runs.record(runId, { type: "run.waitingForUser", at });
      } else {
        this.#runs.record(runId, {
          type: "run.failed",
          at,
          error: { code: "verification-failed", message: result.reason, retryable: false },
        });
      }
    } catch (error) {
      this.#runs.record(runId, {
        type: "run.failed",
        at: new Date().toISOString(),
        error: {
          code: "transport-failed",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      });
    } finally {
      for (const deviceId of leasedDeviceIds) this.#releaseDevice(deviceId);
    }
  }

  async #acquireDevice(requestedDeviceId?: string): Promise<string> {
    while (true) {
      const ready = (await this.#devices.list())
        .filter((candidate) => candidate.state === "ready")
        .sort((left, right) => left.id.localeCompare(right.id));
      if (ready.length === 0) throw new Error("no ready Android device is connected");
      const device = requestedDeviceId
        ? ready.find(
            (candidate) =>
              candidate.id === requestedDeviceId && !this.#leasedDevices.has(candidate.id),
          )
        : ready.find((candidate) => !this.#leasedDevices.has(candidate.id));
      if (device) {
        this.#leasedDevices.add(device.id);
        return device.id;
      }
      if (requestedDeviceId && !ready.some((candidate) => candidate.id === requestedDeviceId)) {
        throw new Error(`requested Android device ${requestedDeviceId} is not ready`);
      }
      await new Promise<void>((resolve) => this.#leaseWaiters.add(resolve));
    }
  }

  async #acquireBroadcastDevices(): Promise<string[]> {
    while (true) {
      const ready = (await this.#devices.list())
        .filter((candidate) => candidate.state === "ready")
        .sort((left, right) => left.id.localeCompare(right.id));
      if (ready.length < 2)
        throw new Error("broadcast requires at least two ready Android devices");
      if (ready.every((candidate) => !this.#leasedDevices.has(candidate.id))) {
        for (const device of ready) this.#leasedDevices.add(device.id);
        return ready.map((device) => device.id);
      }
      await new Promise<void>((resolve) => this.#leaseWaiters.add(resolve));
    }
  }

  #releaseDevice(deviceId: string): void {
    this.#leasedDevices.delete(deviceId);
    for (const resolve of this.#leaseWaiters) resolve();
    this.#leaseWaiters.clear();
  }
}
