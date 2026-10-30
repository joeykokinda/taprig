import type { AgentContext, AgentDecision } from "../agents/loop.ts";
import { runAgentLoop } from "../agents/loop.ts";
import type { DeviceAdapter } from "../core/contracts.ts";
import type { DeviceInventory } from "../daemon/server.ts";
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
  #tail = Promise.resolve();
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
    // shortcut: serialize all runs until fleet scheduling owns per-device leases.
    const work = this.#tail
      .then(() => this.#execute(runId, deviceId))
      .finally(() => this.#active.delete(runId));
    this.#tail = work.catch(() => undefined);
    this.#active.set(runId, work);
  }

  async idle(): Promise<void> {
    await Promise.all(this.#active.values());
  }

  async #execute(runId: string, requestedDeviceId?: string): Promise<void> {
    let run = this.#runs.get(runId);
    if (run?.status !== "created") return;
    run = this.#runs.record(runId, { type: "run.started", at: new Date().toISOString() });
    try {
      if (run.mode !== "independent") throw new Error(`${run.mode} execution is not implemented`);
      const readyDevices = (await this.#devices.list())
        .filter((candidate) => candidate.state === "ready")
        .sort((left, right) => left.id.localeCompare(right.id));
      const device = requestedDeviceId
        ? readyDevices.find((candidate) => candidate.id === requestedDeviceId)
        : readyDevices[0];
      if (!device) throw new Error("no ready Android device is connected");
      const result = await runAgentLoop({
        device: this.#adapter,
        deviceId: device.id,
        decide: this.#decide(run.task),
        verifyCompletion: async () => undefined,
      });
      const at = new Date().toISOString();
      if (result.status === "completed") {
        this.#runs.checkpoint(runId, device.id, {
          summary: result.evidence,
          actions: result.actions,
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
    }
  }
}
