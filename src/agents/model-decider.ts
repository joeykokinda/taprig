import { randomUUID } from "node:crypto";
import type { ModelTarget, OpenAiProviderConfig } from "../models/config.ts";
import { OpenAiResponsesProvider } from "../models/openai.ts";
import type { AgentContext, AgentDecision } from "./loop.ts";

const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "evidence", "question", "reason", "steps"],
  properties: {
    type: { type: "string", enum: ["execute", "complete", "ask_user", "fail"] },
    evidence: { type: ["string", "null"] },
    question: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
    steps: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "actionType", "selectorType", "value", "role"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          actionType: { type: "string", enum: ["tap", "launch", "key"] },
          selectorType: {
            type: "string",
            enum: ["text", "description", "resourceId", "elementId"],
          },
          value: { type: "string", minLength: 1, maxLength: 500 },
          role: { type: ["string", "null"], maxLength: 120 },
        },
      },
    },
  },
} as const;

type ModelDecision = {
  type: "execute" | "complete" | "ask_user" | "fail";
  evidence: string | null;
  question: string | null;
  reason: string | null;
  steps: Array<{
    id: string;
    actionType: "tap" | "launch" | "key";
    selectorType: "text" | "description" | "resourceId" | "elementId";
    value: string;
    role: string | null;
  }>;
};

function parseDecision(value: unknown): AgentDecision {
  const decision = value as Partial<ModelDecision>;
  if (decision.type === "complete" && decision.evidence?.trim()) {
    return { type: "complete", evidence: decision.evidence.trim() };
  }
  if (decision.type === "ask_user" && decision.question?.trim()) {
    return { type: "ask_user", question: decision.question.trim() };
  }
  if (decision.type === "fail" && decision.reason?.trim()) {
    return { type: "fail", reason: decision.reason.trim() };
  }
  if (decision.type !== "execute" || !Array.isArray(decision.steps)) {
    throw new Error("model returned an invalid decision");
  }
  const steps = decision.steps.map((step) => {
    if (!step.id?.trim() || !step.value?.trim()) throw new Error("model returned an invalid step");
    const value = step.value.trim();
    if (step.actionType === "launch") {
      return { id: step.id.trim(), action: { type: "app.launch" as const, packageName: value } };
    }
    if (step.actionType === "key") {
      if (!(["back", "home", "recents", "enter", "delete"] as const).includes(value as never)) {
        throw new Error("model returned an invalid key");
      }
      return {
        id: step.id.trim(),
        action: {
          type: "key.press" as const,
          key: value as "back" | "home" | "recents" | "enter" | "delete",
        },
      };
    }
    const target =
      step.selectorType === "text"
        ? { text: value, ...(step.role ? { role: step.role } : {}) }
        : step.selectorType === "description"
          ? { description: value }
          : step.selectorType === "resourceId"
            ? { resourceId: value }
            : step.selectorType === "elementId"
              ? { elementId: value }
              : undefined;
    if (!target) throw new Error("model returned an invalid selector");
    return { id: step.id.trim(), action: { type: "element.tap" as const, target } };
  });
  return { type: "execute", requestId: randomUUID(), steps };
}

export function createModelDecider(
  task: string,
  target: ModelTarget,
  providerConfig: OpenAiProviderConfig,
  environment: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
): (context: AgentContext) => Promise<AgentDecision> {
  const provider = new OpenAiResponsesProvider(providerConfig, environment, request);
  return async (context) => {
    const observation = {
      foregroundPackage: context.observation.foregroundPackage,
      generation: context.observation.generation,
      elements: context.observation.elements.slice(0, 300).map((element) => ({
        id: element.id,
        role: element.role,
        text: element.text,
        description: element.description,
        resourceId: element.resourceId,
        actionable: element.actionable,
      })),
      previousBatch: context.previousBatch,
    };
    const response = await provider.structured({
      model: target.model,
      ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      schemaName: "taprig_phone_decision",
      schema: decisionSchema,
      system:
        "You control one Android phone with typed launch, key, and exact semantic tap actions. For taps choose only visible selectors. Use a known Android package name for launch and back, home, recents, enter, or delete for keys; put that value in value and set unused selector fields to text/null. Take at most three short actions, then observe again. Mark complete only when the current UI visibly proves the user's task. Ask one precise question when required information is missing. Never guess success.",
      input: JSON.stringify({ task, decisionNumber: context.decisionNumber, observation }),
    });
    return parseDecision(response.value);
  };
}
