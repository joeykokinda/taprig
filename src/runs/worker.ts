import type { AgentContext, AgentDecision } from "../agents/loop.ts";
import { runAgentLoop } from "../agents/loop.ts";
import type { DeviceAdapter } from "../core/contracts.ts";
import type { DeviceInventory } from "../daemon/server.ts";
import { runBroadcast } from "../orchestration/broadcast.ts";
import type {
  CoordinatedNode,
  CoordinatedNodeResult,
  CoordinatedPlan,
} from "../orchestration/coordinated.ts";
import { runCoordinated } from "../orchestration/coordinated.ts";
import type { RunService } from "./service.ts";

export interface RunWorkerOptions {
  runs: RunService;
  devices: DeviceInventory;
  adapter: DeviceAdapter;
  decide(task: string): Decider;
  planCoordinated?(task: string): Promise<CoordinatedPlan>;
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
  readonly #planCoordinated: ((task: string) => Promise<CoordinatedPlan>) | undefined;

  constructor(options: RunWorkerOptions) {
    this.#runs = options.runs;
    this.#devices = options.devices;
    this.#adapter = options.adapter;
    this.#decide = options.decide;
    this.#planCoordinated = options.planCoordinated;
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
      if (run.mode === "coordinated") {
        if (!this.#planCoordinated) throw new Error("coordinated planner is not configured");
        const result = await runCoordinated({
          plan: await this.#planCoordinated(run.task),
          execute: (node, dependencies) =>
            this.#executeCoordinatedNode(
              node,
              dependencies.map(({ id, evidence }) => `${id}: ${evidence}`),
            ),
        });
        const at = new Date().toISOString();
        const devices = result.nodes.flatMap((node) =>
          "deviceId" in node && node.deviceId ? [node.deviceId] : [],
        );
        this.#runs.checkpoint(runId, devices[0] ?? "coordinator", {
          summary: Object.fromEntries(
            result.nodes.flatMap((node) =>
              node.status === "completed" ? [[node.id, node.evidence]] : [],
            ),
          ),
          actions: result.nodes.flatMap((node) =>
            node.status === "completed" ? node.actions : [],
          ),
          devices: [...new Set(devices)],
          nodes: result.nodes,
        });
        if (result.status === "completed") {
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
        return;
      }
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

  async #executeCoordinatedNode(
    node: CoordinatedNode,
    dependencies: readonly string[],
  ): Promise<CoordinatedNodeResult> {
    let deviceId: string | undefined;
    try {
      deviceId = await this.#acquireDevice(node.deviceId);
      const result = await runAgentLoop({
        device: this.#adapter,
        deviceId,
        decide: this.#decide(
          dependencies.length > 0
            ? `${node.task}\n\nVerified dependency results:\n${dependencies.join("\n")}`
            : node.task,
        ),
        verifyCompletion: async () => undefined,
      });
      if (result.status === "completed") {
        return {
          id: node.id,
          status: "completed",
          deviceId,
          evidence: result.evidence,
          actions: result.actions,
        };
      }
      if (result.status === "waiting-for-user") {
        return { id: node.id, status: "waiting-for-user", deviceId, question: result.question };
      }
      return { id: node.id, status: "failed", deviceId, reason: result.reason };
    } finally {
      if (deviceId) this.#releaseDevice(deviceId);
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
