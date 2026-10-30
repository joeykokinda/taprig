import { randomUUID } from "node:crypto";

import type { RunEvent, RunMode, RunState } from "../core/contracts.ts";
import type { StoredRunEvent, TapRigStore } from "../persistence/store.ts";

export class RunService {
  readonly store: TapRigStore;
  readonly now: () => string;
  readonly id: () => string;

  constructor(
    store: TapRigStore,
    now = () => new Date().toISOString(),
    id: () => string = randomUUID,
  ) {
    this.store = store;
    this.now = now;
    this.id = id;
  }

  create(task: string, mode: RunMode = "independent"): RunState {
    const normalized = task.trim();
    if (!normalized || normalized.length > 10_000) {
      throw new Error("task must contain from 1 to 10000 characters");
    }
    if (mode !== "independent" && mode !== "broadcast" && mode !== "coordinated") {
      throw new Error("invalid run mode");
    }
    const at = this.now();
    const run: RunState = {
      id: this.id(),
      mode,
      task: normalized,
      status: "created",
      createdAt: at,
      updatedAt: at,
    };
    return this.store.recordRunEvent(undefined, { type: "run.created", run });
  }

  list(): RunState[] {
    return this.store.listRuns();
  }

  get(id: string): RunState | undefined {
    return this.store.getRun(id);
  }

  events(id: string, afterSequence = 0): StoredRunEvent[] {
    return this.store.listRunEvents(id, afterSequence);
  }

  record(id: string, event: Exclude<RunEvent, { type: "run.created" }>): RunState {
    const run = this.get(id);
    if (!run) throw new Error(`run ${id} not found`);
    return this.store.recordRunEvent(run, event);
  }

  question(runId: string, prompt: string): void {
    this.store.saveQuestion({
      id: this.id(),
      runId,
      prompt,
      status: "open",
      createdAt: this.now(),
    });
  }

  checkpoint(runId: string, deviceId: string, evidence: unknown): void {
    this.store.saveCheckpoint({
      id: this.id(),
      runId,
      deviceId,
      name: "completion",
      evidence,
      createdAt: this.now(),
    });
  }

  completion(runId: string) {
    return this.store.getCheckpoint(runId, "completion");
  }
}
