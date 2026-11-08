import type { ModelTarget, ProviderConfig } from "../models/config.ts";
import { createStructuredProvider } from "../models/providers.ts";
import { estimateCostUsd, type RecordModelUsage } from "../models/usage.ts";
import type { CoordinatedPlan } from "../orchestration/coordinated.ts";
import { validateCoordinatedPlan } from "../orchestration/coordinated.ts";

const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["nodes"],
  properties: {
    nodes: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "task", "dependsOn", "deviceId", "capabilities"],
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$" },
          task: { type: "string", minLength: 1, maxLength: 10_000 },
          dependsOn: {
            type: "array",
            maxItems: 20,
            uniqueItems: true,
            items: { type: "string" },
          },
          deviceId: { type: ["string", "null"] },
          capabilities: {
            type: "array",
            uniqueItems: true,
            items: {
              type: "string",
              enum: [
                "semantic-observation",
                "semantic-action",
                "raw-input",
                "video",
                "screenshot",
                "shell",
              ],
            },
          },
        },
      },
    },
  },
} as const;

type ModelPlan = {
  nodes: Array<{
    id: string;
    task: string;
    dependsOn: string[];
    deviceId: string | null;
    capabilities: CoordinatedPlan["nodes"][number]["capabilities"];
  }>;
};

export function createModelCoordinator(
  target: ModelTarget,
  providerConfig: ProviderConfig,
  environment: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
  recordUsage?: RecordModelUsage,
): (task: string) => Promise<CoordinatedPlan> {
  return async (task) => {
    let attempted = false;
    const provider = createStructuredProvider(providerConfig, environment, request);
    let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    try {
      attempted = true;
      const response = await provider.structured({
        model: target.model,
        ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
        schemaName: "taprig_coordinated_plan",
        schema: planSchema,
        system:
          "Decompose one phone-fleet request into the smallest acyclic task graph. Each node is one independently verifiable phone task. Use dependencies only when a node needs an earlier result. Leave deviceId null unless the user explicitly names a device. Require semantic-observation and semantic-action for ordinary phone work; add video, screenshot, raw-input, or shell only when the work specifically needs it. Do not invent tasks, credentials, recipients, content, or success.",
        input: task,
      });
      usage = {
        inputTokens: response.inputTokens ?? 0,
        outputTokens: response.outputTokens ?? 0,
        costUsd: estimateCostUsd(
          target.model,
          response.inputTokens ?? 0,
          response.outputTokens ?? 0,
        ),
      };
      const value = response.value as Partial<ModelPlan>;
      if (!Array.isArray(value.nodes)) {
        throw new Error("model returned an invalid coordinated plan");
      }
      const plan: CoordinatedPlan = {
        nodes: value.nodes.map((node) => ({
          id: node.id,
          task: node.task.trim(),
          dependsOn: node.dependsOn,
          ...(node.deviceId?.trim() ? { deviceId: node.deviceId.trim() } : {}),
          ...(node.capabilities?.length ? { capabilities: node.capabilities } : {}),
        })),
      };
      validateCoordinatedPlan(plan);
      return plan;
    } finally {
      if (attempted) recordUsage?.(usage);
    }
  };
}
