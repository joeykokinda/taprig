import type { AgentContext, AgentDecision, AgentLoopResult } from "../agents/loop.ts";
import type { ActionStep, BatchResult, DeviceAdapter } from "../core/contracts.ts";

export type BroadcastResult =
  | {
      status: "completed";
      evidence: Readonly<Record<string, string>>;
      actions: readonly ActionStep[];
      decisions: number;
    }
  | {
      status: "waiting-for-user";
      interaction: "question" | "approval";
      question: string;
      decisions: number;
    }
  | { status: "failed"; reason: string; decisions: number };

export interface BroadcastOptions {
  device: DeviceAdapter;
  deviceIds: readonly string[];
  decide(context: AgentContext): Promise<AgentDecision>;
  recover(deviceId: string): Promise<AgentLoopResult>;
  maxDecisions?: number;
}

export async function runBroadcast(options: BroadcastOptions): Promise<BroadcastResult> {
  if (options.deviceIds.length < 2) throw new Error("broadcast requires at least two devices");
  const maxDecisions = options.maxDecisions ?? 40;
  const actions: ActionStep[] = [];
  let previousBatch: BatchResult | undefined;

  for (let decisionNumber = 0; decisionNumber < maxDecisions; decisionNumber += 1) {
    const observations = await Promise.all(
      options.deviceIds.map((deviceId) => options.device.observe(deviceId)),
    );
    const leader = observations[0];
    if (!leader) throw new Error("broadcast leader observation is unavailable");
    const decision = await options.decide({
      observation: leader,
      decisionNumber,
      ...(previousBatch ? { previousBatch } : {}),
    });
    if (decision.type === "ask_user") {
      return {
        status: "waiting-for-user",
        interaction: "question",
        question: decision.question,
        decisions: decisionNumber + 1,
      };
    }
    if (decision.type === "request_approval") {
      return {
        status: "waiting-for-user",
        interaction: "approval",
        question: decision.prompt,
        decisions: decisionNumber + 1,
      };
    }
    if (decision.type === "fail") {
      return { status: "failed", reason: decision.reason, decisions: decisionNumber + 1 };
    }
    if (decision.type === "complete") {
      const evidence: Record<string, string> = { [leader.deviceId]: decision.evidence };
      const recovered = await Promise.all(
        options.deviceIds.slice(1).map(async (deviceId) => ({
          deviceId,
          result: await options.recover(deviceId),
        })),
      );
      for (const item of recovered) {
        if (item.result.status === "waiting-for-user") {
          return {
            status: "waiting-for-user",
            interaction: item.result.interaction,
            question: `${item.deviceId}: ${item.result.question}`,
            decisions: decisionNumber + 1,
          };
        }
        if (item.result.status === "failed") {
          return {
            status: "failed",
            reason: `${item.deviceId}: ${item.result.reason}`,
            decisions: decisionNumber + 1,
          };
        }
        evidence[item.deviceId] = item.result.evidence;
      }
      return { status: "completed", evidence, actions, decisions: decisionNumber + 1 };
    }
    if (decision.steps.length === 0) {
      return {
        status: "failed",
        reason: "broadcast planner returned no actions",
        decisions: decisionNumber + 1,
      };
    }

    const batches = await Promise.all(
      observations.map((observation) =>
        options.device.execute({
          requestId: `${decision.requestId}:${observation.deviceId}`,
          deviceId: observation.deviceId,
          observationGeneration: observation.generation,
          steps: decision.steps,
        }),
      ),
    );
    previousBatch = batches[0];
    const drifted = batches.filter((batch) =>
      batch.steps.some((step) => step.status !== "verified"),
    );
    const recovery = await Promise.all(
      drifted.map(async (batch) => ({
        deviceId: batch.deviceId,
        result: await options.recover(batch.deviceId),
      })),
    );
    const failed = recovery.find((item) => item.result.status !== "completed");
    if (failed?.result.status === "waiting-for-user") {
      return {
        status: "waiting-for-user",
        interaction: failed.result.interaction,
        question: `${failed.deviceId}: ${failed.result.question}`,
        decisions: decisionNumber + 1,
      };
    }
    if (failed?.result.status === "failed") {
      return {
        status: "failed",
        reason: `${failed.deviceId}: ${failed.result.reason}`,
        decisions: decisionNumber + 1,
      };
    }
    actions.push(...decision.steps);
  }
  return {
    status: "failed",
    reason: "broadcast decision budget exhausted",
    decisions: maxDecisions,
  };
}
