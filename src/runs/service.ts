import { randomUUID } from "node:crypto";

import type { RunAffinity, RunBudget, RunEvent, RunMode, RunState } from "../core/contracts.ts";
import type { StoredQuestion, StoredRunEvent, TapRigStore } from "../persistence/store.ts";

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

  create(
    task: string,
    mode: RunMode = "independent",
    budget?: RunBudget,
    affinity?: RunAffinity,
  ): RunState {
    const normalized = task.trim();
    if (!normalized || normalized.length > 10_000) {
      throw new Error("task must contain from 1 to 10000 characters");
    }
    if (mode !== "independent" && mode !== "broadcast" && mode !== "coordinated") {
      throw new Error("invalid run mode");
    }
    const normalizedBudget = normalizeBudget(budget);
    const normalizedAffinity = normalizeAffinity(affinity, mode);
    const at = this.now();
    const run: RunState = {
      id: this.id(),
      mode,
      ...(normalizedBudget ? { budget: normalizedBudget } : {}),
      ...(normalizedAffinity ? { affinity: normalizedAffinity } : {}),
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

  active(): RunState[] {
    return this.store.listActiveRuns();
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

  question(
    runId: string,
    prompt: string,
    deviceId?: string,
    deviceIds?: readonly string[],
  ): StoredQuestion {
    const question: StoredQuestion = {
      id: this.id(),
      runId,
      prompt,
      kind: "question",
      status: "open",
      createdAt: this.now(),
      ...(deviceId ? { deviceId } : {}),
      ...(deviceIds ? { deviceIds: [...deviceIds] } : {}),
    };
    this.store.saveQuestion(question);
    return question;
  }

  questions(runId: string): StoredQuestion[] {
    if (!this.get(runId)) throw new Error(`run ${runId} not found`);
    return this.store.listQuestions(runId).filter((item) => item.kind !== "approval");
  }

  approval(
    runId: string,
    prompt: string,
    deviceId?: string,
    deviceIds?: readonly string[],
  ): StoredQuestion {
    const approval: StoredQuestion = {
      id: this.id(),
      runId,
      prompt,
      kind: "approval",
      status: "open",
      createdAt: this.now(),
      ...(deviceId ? { deviceId } : {}),
      ...(deviceIds ? { deviceIds: [...deviceIds] } : {}),
    };
    this.store.saveQuestion(approval);
    this.record(runId, {
      type: "approval.requested",
      at: approval.createdAt,
      approvalId: approval.id,
      prompt: approval.prompt,
    });
    return approval;
  }

  approvals(runId: string): StoredQuestion[] {
    if (!this.get(runId)) throw new Error(`run ${runId} not found`);
    return this.store.listQuestions(runId).filter((item) => item.kind === "approval");
  }

  answer(runId: string, questionId: string, answer: string, sensitive = false): StoredQuestion {
    const run = this.get(runId);
    if (run?.status !== "waiting-for-user") throw new Error("run is not waiting for an answer");
    if (!answer.trim() || answer.length > 10_000) {
      throw new Error("answer must contain from 1 to 10000 characters");
    }
    if (!this.questions(runId).some((question) => question.id === questionId)) {
      throw new Error("question is not open");
    }
    return this.store.answerQuestion(
      runId,
      questionId,
      sensitive ? undefined : answer.trim(),
      sensitive,
      this.now(),
    );
  }

  resolveApproval(
    runId: string,
    approvalId: string,
    decision: "approved" | "denied",
  ): StoredQuestion {
    const run = this.get(runId);
    if (run?.status !== "waiting-for-user") throw new Error("run is not waiting for approval");
    const approval = this.approvals(runId).find(
      (item) => item.id === approvalId && item.status === "open",
    );
    if (!approval) throw new Error("approval is not open");
    const at = this.now();
    const resolved = this.store.answerQuestion(runId, approvalId, decision, false, at);
    this.record(runId, { type: "approval.resolved", at, approvalId, decision });
    return resolved;
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

  saveRecovery(runId: string, evidence: unknown): void {
    this.store.saveCheckpoint({
      id: this.id(),
      runId,
      deviceId: "runtime",
      name: "recovery",
      evidence,
      createdAt: this.now(),
    });
  }

  recovery(runId: string) {
    return this.store.getCheckpoint(runId, "recovery");
  }

  saveTelemetry(runId: string, telemetry: unknown): void {
    this.store.saveCheckpoint({
      id: this.id(),
      runId,
      deviceId: "runtime",
      name: "telemetry",
      evidence: telemetry,
      createdAt: this.now(),
    });
  }

  telemetry(runId: string) {
    return this.store.getCheckpoint(runId, "telemetry");
  }
}

function normalizeAffinity(
  affinity: RunAffinity | undefined,
  mode: RunMode,
): RunAffinity | undefined {
  if (affinity === undefined) return undefined;
  if (!affinity || typeof affinity !== "object" || Array.isArray(affinity)) {
    throw new Error("affinity must be an object");
  }
  const values = affinity as unknown as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== "deviceIds" && key !== "group")) {
    throw new Error("affinity contains an unknown field");
  }
  if (
    !Array.isArray(affinity.deviceIds) ||
    affinity.deviceIds.length < (mode === "broadcast" ? 2 : 1) ||
    affinity.deviceIds.length > 100 ||
    affinity.deviceIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 300) ||
    new Set(affinity.deviceIds).size !== affinity.deviceIds.length
  ) {
    throw new Error(
      mode === "broadcast"
        ? "broadcast affinity requires from 2 to 100 unique device IDs"
        : "affinity requires from 1 to 100 unique device IDs",
    );
  }
  if (affinity.group !== undefined && (!affinity.group.trim() || affinity.group.length > 64)) {
    throw new Error("affinity group is invalid");
  }
  return {
    deviceIds: affinity.deviceIds.map((id) => id.trim()),
    ...(affinity.group ? { group: affinity.group } : {}),
  };
}

function normalizeBudget(budget: RunBudget | undefined): RunBudget | undefined {
  if (budget === undefined) return undefined;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    throw new Error("budget must be an object");
  }
  const values = budget as Record<string, unknown>;
  if (Object.keys(values).some((key) => key !== "maxModelCalls" && key !== "maxActions")) {
    throw new Error("budget contains an unknown field");
  }
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
      throw new Error(`${name} must be an integer from 1 to 10000`);
    }
  }
  return Object.keys(values).length > 0 ? { ...budget } : undefined;
}
