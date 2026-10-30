import type {
  ActionStep,
  BatchResult,
  DeviceAdapter,
  DeviceId,
  Observation,
} from "../core/contracts.ts";

export type AgentDecision =
  | { type: "execute"; requestId: string; steps: readonly ActionStep[] }
  | { type: "complete"; evidence: string }
  | { type: "ask_user"; question: string }
  | { type: "fail"; reason: string };

export interface AgentContext {
  observation: Observation;
  decisionNumber: number;
  previousBatch?: BatchResult;
}

export type AgentLoopResult =
  | { status: "completed"; evidence: string; decisions: number; actions: readonly ActionStep[] }
  | { status: "waiting-for-user"; question: string; decisions: number }
  | { status: "failed"; reason: string; decisions: number };

export interface AgentLoopOptions {
  device: DeviceAdapter;
  deviceId: DeviceId;
  decide(context: AgentContext): Promise<AgentDecision>;
  verifyCompletion(observation: Observation): Promise<string | undefined>;
  maxDecisions?: number;
  maxFailedBatches?: number;
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxDecisions = options.maxDecisions ?? 20;
  const maxFailedBatches = options.maxFailedBatches ?? 3;
  if (!Number.isSafeInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 100) {
    throw new Error("maxDecisions must be an integer from 1 to 100");
  }
  if (!Number.isSafeInteger(maxFailedBatches) || maxFailedBatches < 0 || maxFailedBatches > 20) {
    throw new Error("maxFailedBatches must be an integer from 0 to 20");
  }

  let previousBatch: BatchResult | undefined;
  const executedActions: ActionStep[] = [];
  let failedBatches = 0;
  let previousFailure: { generation: string; actions: string } | undefined;

  for (let decisionNumber = 0; decisionNumber < maxDecisions; decisionNumber += 1) {
    const observation = await options.device.observe(options.deviceId);
    const evidence = await options.verifyCompletion(observation);
    if (evidence)
      return { status: "completed", evidence, decisions: decisionNumber, actions: executedActions };

    const context: AgentContext = {
      observation,
      decisionNumber,
      ...(previousBatch ? { previousBatch } : {}),
    };
    const decision = await options.decide(context);
    if (decision.type === "complete") {
      return {
        status: "completed",
        evidence: decision.evidence,
        decisions: decisionNumber + 1,
        actions: executedActions,
      };
    }
    if (decision.type === "ask_user") {
      return {
        status: "waiting-for-user",
        question: decision.question,
        decisions: decisionNumber + 1,
      };
    }
    if (decision.type === "fail") {
      return { status: "failed", reason: decision.reason, decisions: decisionNumber + 1 };
    }
    if (decision.steps.length === 0) {
      return {
        status: "failed",
        reason: "planner returned an empty action batch",
        decisions: decisionNumber + 1,
      };
    }

    const actions = JSON.stringify(decision.steps.map((step) => step.action));
    if (
      previousFailure?.generation === observation.generation &&
      previousFailure.actions === actions
    ) {
      return {
        status: "failed",
        reason: "planner repeated a failed action against unchanged state",
        decisions: decisionNumber + 1,
      };
    }

    previousBatch = await options.device.execute({
      requestId: decision.requestId,
      deviceId: options.deviceId,
      observationGeneration: observation.generation,
      steps: decision.steps,
    });
    for (const [index, result] of previousBatch.steps.entries()) {
      const step = decision.steps[index];
      if (result?.status === "verified" && step) executedActions.push(step);
    }
    if (previousBatch.steps.some((step) => step.status === "failed")) {
      failedBatches += 1;
      previousFailure = { generation: observation.generation, actions };
      if (failedBatches > maxFailedBatches) {
        return {
          status: "failed",
          reason: "recovery budget exhausted",
          decisions: decisionNumber + 1,
        };
      }
    } else {
      previousFailure = undefined;
    }
  }

  return { status: "failed", reason: "decision budget exhausted", decisions: maxDecisions };
}
