import type { ActionStep } from "../core/contracts.ts";

export interface CoordinatedNode {
  id: string;
  task: string;
  dependsOn: readonly string[];
  deviceId?: string;
}

export interface CoordinatedPlan {
  nodes: readonly CoordinatedNode[];
}

export type CoordinatedNodeResult =
  | {
      id: string;
      status: "completed";
      deviceId: string;
      evidence: string;
      actions: readonly ActionStep[];
    }
  | { id: string; status: "waiting-for-user"; deviceId: string; question: string }
  | { id: string; status: "failed"; deviceId?: string; reason: string }
  | { id: string; status: "skipped"; reason: string };

export type CoordinatedResult =
  | { status: "completed"; nodes: readonly CoordinatedNodeResult[] }
  | { status: "waiting-for-user"; question: string; nodes: readonly CoordinatedNodeResult[] }
  | { status: "failed"; reason: string; nodes: readonly CoordinatedNodeResult[] };

export interface CoordinatedOptions {
  plan: CoordinatedPlan;
  initialResults?: readonly Extract<CoordinatedNodeResult, { status: "completed" }>[];
  execute(
    node: CoordinatedNode,
    dependencies: readonly Extract<CoordinatedNodeResult, { status: "completed" }>[],
  ): Promise<CoordinatedNodeResult>;
}

export function validateCoordinatedPlan(plan: CoordinatedPlan): void {
  if (!Array.isArray(plan.nodes) || plan.nodes.length < 1 || plan.nodes.length > 100) {
    throw new Error("coordinated plan must contain from 1 to 100 nodes");
  }
  const nodes = new Map<string, CoordinatedNode>();
  for (const node of plan.nodes) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(node.id)) {
      throw new Error(`invalid coordinated node id ${node.id}`);
    }
    if (nodes.has(node.id)) throw new Error(`duplicate coordinated node id ${node.id}`);
    if (!node.task.trim() || node.task.length > 10_000) {
      throw new Error(`coordinated node ${node.id} has an invalid task`);
    }
    if (!Array.isArray(node.dependsOn) || new Set(node.dependsOn).size !== node.dependsOn.length) {
      throw new Error(`coordinated node ${node.id} has invalid dependencies`);
    }
    if (node.deviceId !== undefined && !node.deviceId.trim()) {
      throw new Error(`coordinated node ${node.id} has an invalid device id`);
    }
    nodes.set(node.id, node);
  }
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) throw new Error(`coordinated node ${node.id} depends on itself`);
      if (!nodes.has(dependency)) {
        throw new Error(`coordinated node ${node.id} has unknown dependency ${dependency}`);
      }
    }
  }

  const completed = new Set<string>();
  while (completed.size < nodes.size) {
    const ready = plan.nodes.filter(
      (node) => !completed.has(node.id) && node.dependsOn.every((id: string) => completed.has(id)),
    );
    if (ready.length === 0) throw new Error("coordinated plan contains a dependency cycle");
    for (const node of ready) completed.add(node.id);
  }
}

export async function runCoordinated(options: CoordinatedOptions): Promise<CoordinatedResult> {
  validateCoordinatedPlan(options.plan);
  const nodeIds = new Set(options.plan.nodes.map((node) => node.id));
  const results = new Map<string, CoordinatedNodeResult>();
  for (const result of options.initialResults ?? []) {
    if (!nodeIds.has(result.id) || results.has(result.id)) {
      throw new Error(`invalid initial coordinated result ${result.id}`);
    }
    results.set(result.id, result);
  }
  for (const result of results.values()) {
    const node = options.plan.nodes.find((candidate) => candidate.id === result.id);
    if (!node?.dependsOn.every((id) => results.has(id))) {
      throw new Error(`initial coordinated result ${result.id} is missing a dependency`);
    }
  }

  while (results.size < options.plan.nodes.length) {
    for (const node of options.plan.nodes) {
      if (results.has(node.id)) continue;
      const blockedBy = node.dependsOn
        .map((id) => results.get(id))
        .find((result) => result && result.status !== "completed");
      if (blockedBy) {
        results.set(node.id, {
          id: node.id,
          status: "skipped",
          reason: `dependency ${blockedBy.id} did not complete`,
        });
      }
    }
    const ready = options.plan.nodes.filter(
      (node) =>
        !results.has(node.id) &&
        node.dependsOn.every((id) => results.get(id)?.status === "completed"),
    );
    if (ready.length === 0) continue;
    const settled = await Promise.all(
      ready.map(async (node): Promise<CoordinatedNodeResult> => {
        try {
          const dependencies = node.dependsOn.map(
            (id) => results.get(id) as Extract<CoordinatedNodeResult, { status: "completed" }>,
          );
          const result = await options.execute(node, dependencies);
          if (result.id !== node.id) throw new Error(`executor returned result for ${result.id}`);
          return result;
        } catch (error) {
          return {
            id: node.id,
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    for (const result of settled) results.set(result.id, result);
  }

  const ordered = options.plan.nodes.map((node) => results.get(node.id) as CoordinatedNodeResult);
  const waiting = ordered.find((result) => result.status === "waiting-for-user");
  if (waiting?.status === "waiting-for-user") {
    return {
      status: "waiting-for-user",
      question: `${waiting.id}: ${waiting.question}`,
      nodes: ordered,
    };
  }
  const failed = ordered.find((result) => result.status === "failed");
  if (failed?.status === "failed") {
    return { status: "failed", reason: `${failed.id}: ${failed.reason}`, nodes: ordered };
  }
  return { status: "completed", nodes: ordered };
}
