import { randomUUID } from "node:crypto";
import type { Selector } from "../core/contracts.ts";
import type { ModelTarget, ProviderConfig } from "../models/config.ts";
import { createStructuredProvider } from "../models/providers.ts";
import { estimateCostUsd, type RecordModelUsage } from "../models/usage.ts";
import type { ApprovalPolicy } from "../settings.ts";
import type { AgentContext, AgentDecision } from "./loop.ts";

const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type", "evidence", "question", "approval", "reason", "steps"],
  properties: {
    type: {
      type: "string",
      enum: ["execute", "complete", "ask_user", "request_approval", "fail"],
    },
    evidence: { type: ["string", "null"] },
    question: { type: ["string", "null"] },
    approval: { type: ["string", "null"] },
    reason: { type: ["string", "null"] },
    steps: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "actionType", "selectorType", "value", "input", "role"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          actionType: {
            type: "string",
            enum: ["tap", "longTap", "text", "launch", "key", "scroll", "tapPoint"],
          },
          selectorType: {
            type: "string",
            enum: ["text", "description", "resourceId", "elementId"],
          },
          value: { type: "string", minLength: 1, maxLength: 500 },
          input: { type: ["string", "null"], minLength: 1, maxLength: 10_000 },
          role: { type: ["string", "null"], maxLength: 120 },
        },
      },
    },
  },
} as const;

type ModelDecision = {
  type: "execute" | "complete" | "ask_user" | "request_approval" | "fail";
  evidence: string | null;
  question: string | null;
  approval: string | null;
  reason: string | null;
  steps: Array<{
    id: string;
    actionType: "tap" | "longTap" | "text" | "launch" | "key" | "scroll" | "tapPoint";
    selectorType: "text" | "description" | "resourceId" | "elementId";
    value: string;
    input: string | null;
    role: string | null;
  }>;
};

type Bounds = NonNullable<AgentContext["observation"]["elements"][number]["bounds"]>;

// Finger moves against the scroll direction: scrolling down drags from low on the screen to high.
function scrollGesture(direction: string, screen: Bounds) {
  const width = screen.right - screen.left;
  const height = screen.bottom - screen.top;
  const at = (x: number, y: number) => ({
    x: Math.round(screen.left + width * x),
    y: Math.round(screen.top + height * y),
  });
  const gestures: Record<string, [ReturnType<typeof at>, ReturnType<typeof at>]> = {
    down: [at(0.5, 0.75), at(0.5, 0.3)],
    up: [at(0.5, 0.3), at(0.5, 0.75)],
    right: [at(0.8, 0.5), at(0.2, 0.5)],
    left: [at(0.2, 0.5), at(0.8, 0.5)],
  };
  const gesture =
    gestures[
      direction
        .trim()
        .toLowerCase()
        .replace(/^scroll\s+/u, "")
    ];
  if (!gesture) throw new Error(`model returned an invalid scroll direction "${direction}"`);
  return { type: "gesture.swipe" as const, from: gesture[0], to: gesture[1], durationMs: 350 };
}

function screenBounds(context: AgentContext): Bounds {
  let screen: Bounds = { left: 0, top: 0, right: 720, bottom: 1600 };
  for (const element of context.observation.elements) {
    const bounds = element.bounds;
    if (!bounds) continue;
    if (
      (bounds.right - bounds.left) * (bounds.bottom - bounds.top) >
      (screen.right - screen.left) * (screen.bottom - screen.top)
    ) {
      screen = bounds;
    }
  }
  return screen;
}

type ObservedElement = AgentContext["observation"]["elements"][number];

// Mirrors driver resolution: actionable matches win, and a selector is usable only if it is unique.
function resolvesUniquely(
  elements: readonly ObservedElement[],
  selector: Selector,
  id: string,
): boolean {
  const matches = elements.filter((element) =>
    "resourceId" in selector
      ? element.resourceId === selector.resourceId
      : "description" in selector
        ? element.description === selector.description
        : "text" in selector
          ? element.text === selector.text && (!selector.role || element.role === selector.role)
          : false,
  );
  const actionable = matches.filter((element) => element.actionable);
  const candidates = actionable.length > 0 ? actionable : matches;
  return candidates.length === 1 && candidates[0]?.id === id;
}

/**
 * Element IDs are positions in one snapshot and go stale as soon as the screen moves. Swap them
 * for an equivalent semantic selector, which the driver can re-resolve on the live screen.
 */
export function stableSelector(elements: readonly ObservedElement[], elementId: string): Selector {
  const element = elements.find((candidate) => candidate.id === elementId);
  if (!element) return { elementId };
  const options: Selector[] = [
    ...(element.resourceId ? [{ resourceId: element.resourceId }] : []),
    ...(element.text ? [{ text: element.text, role: element.role }] : []),
    ...(element.description ? [{ description: element.description }] : []),
  ];
  return (
    options.find((selector) => resolvesUniquely(elements, selector, element.id)) ?? { elementId }
  );
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(image: Buffer): { width: number; height: number } | undefined {
  if (image.length < 24 || image.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

function parseDecision(
  value: unknown,
  screen: Bounds,
  elements: readonly ObservedElement[] = [],
  screenshot?: { width: number; height: number },
): AgentDecision {
  const decision = value as Partial<ModelDecision>;
  if (decision.type === "complete" && decision.evidence?.trim()) {
    return { type: "complete", evidence: decision.evidence.trim() };
  }
  if (decision.type === "ask_user" && decision.question?.trim()) {
    return { type: "ask_user", question: decision.question.trim() };
  }
  if (decision.type === "request_approval" && decision.approval?.trim()) {
    return { type: "request_approval", prompt: decision.approval.trim() };
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
    if (step.actionType === "tapPoint") {
      // Normalized 0-1000 coordinates survive any provider-side image downscaling.
      const match = /^(\d{1,4})\s*,\s*(\d{1,4})$/u.exec(value);
      const x = Number(match?.[1]);
      const y = Number(match?.[2]);
      if (!screenshot || !match || x > 1000 || y > 1000) {
        throw new Error("model returned an invalid tapPoint");
      }
      return {
        id: step.id.trim(),
        action: {
          type: "gesture.tap" as const,
          x: Math.min(screenshot.width - 1, Math.round((x / 1000) * screenshot.width)),
          y: Math.min(screenshot.height - 1, Math.round((y / 1000) * screenshot.height)),
        },
      };
    }
    if (step.actionType === "scroll") {
      return { id: step.id.trim(), action: scrollGesture(value, screen) };
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
              ? stableSelector(elements, value)
              : undefined;
    if (!target) throw new Error("model returned an invalid selector");
    if (step.actionType === "text") {
      if (step.input === null) throw new Error("model returned text without input");
      return {
        id: step.id.trim(),
        action: { type: "element.text" as const, target, value: step.input, clear: true },
      };
    }
    return {
      id: step.id.trim(),
      action: {
        type:
          step.actionType === "longTap" ? ("element.longTap" as const) : ("element.tap" as const),
        target,
      },
    };
  });
  return { type: "execute", requestId: randomUUID(), steps };
}

export function createModelDecider(
  task: string,
  target: ModelTarget,
  providerConfig: ProviderConfig,
  environment: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
  recordUsage?: RecordModelUsage,
  approvalPolicy: ApprovalPolicy = "explicit",
  captureScreenshot?: (deviceId: string) => Promise<Buffer>,
  listPackages?: (deviceId: string) => Promise<readonly string[]>,
): (context: AgentContext) => Promise<AgentDecision> {
  return async (context) => {
    // Installed packages let the model launch any app by its real name instead of guessing.
    const launchMissed = context.previousBatch?.steps.some(
      (step, index) =>
        step.status === "failed" &&
        context.history?.at(-1)?.steps[index]?.action.type === "app.launch",
    );
    const installedPackages =
      listPackages && (context.decisionNumber === 0 || launchMissed)
        ? await listPackages(context.observation.deviceId).catch(() => undefined)
        : undefined;
    // Vision is the fallback: only screens with little semantic text, or after a missed target.
    const labeled = context.observation.elements.filter(
      (element) => element.text || element.description,
    ).length;
    const missed = context.previousBatch?.steps.some(
      (step) =>
        step.error?.code === "target-not-found" || step.error?.code === "verification-failed",
    );
    const image =
      captureScreenshot && (labeled < 5 || missed)
        ? await captureScreenshot(context.observation.deviceId).catch(() => undefined)
        : undefined;
    const screenshot = image ? pngSize(image) : undefined;
    const observation = {
      foregroundPackage: context.observation.foregroundPackage,
      generation: context.observation.generation,
      // Layout-only nodes carry no meaning for the model; keep the ones it can name or act on.
      elements: context.observation.elements
        .filter(
          (element) =>
            element.actionable || element.text || element.description || element.resourceId,
        )
        .slice(0, 300)
        .map((element) => ({
          id: element.id,
          role: element.role,
          text: element.text,
          description: element.description,
          resourceId: element.resourceId,
          actionable: element.actionable,
          ...(element.password ? { password: true } : {}),
        })),
      previousBatch: context.previousBatch,
      recentActions: context.history,
      ...(screenshot ? { screenshotAttached: true } : {}),
      ...(installedPackages ? { installedPackages } : {}),
    };
    let attempted = false;
    let recorded = false;
    const provider = createStructuredProvider(providerConfig, environment, request);
    let rejected: string | undefined;
    try {
      // One malformed decision goes back to the model with the reason before the run fails.
      for (;;) {
        attempted = true;
        recorded = false;
        const response = await provider.structured({
          model: target.model,
          ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
          schemaName: "taprig_phone_decision",
          schema: decisionSchema,
          system: `You control one Android phone with typed launch, key, scroll, semantic tap, long-tap, and text-entry actions. For tap/longTap/text choose only a visible selector in value, preferring elementId; for text put the exact text in input. For launch put the Android package name in value; for key put back, home, recents, enter, or delete; for scroll put down, up, left, or right to reveal content off screen. Only when a screenshot is attached, tapPoint may tap what the elements do not describe: put "x,y" in value on a 0-1000 grid across the image width and height. Set input null when unused. Take at most three short actions, then observe again. recentActions lists your last batches with their outcomes; never repeat a sequence that already failed or looped. Mark complete only when the current UI visibly proves the user's task. Ask one precise question when required information is missing: for a login that needs credentials the task did not give, ask for the username first and the password in a separate question that says it is a password. When the task says the user answered with a secret, type the literal placeholder it names in input. Elements marked password hide what they contain: a verified text action on one means the value is in, so move on to submitting rather than retyping. When the screen shows a captcha, a code sent to another device, a biometric or hardware prompt, or anything only the phone's owner can do, do not attempt it: ask_user with exact instructions, for example "Solve the captcha on the phone screen (use TAKE CONTROL in the control room), then answer done", and continue after the answer. ${approvalPolicy === "explicit" ? "Request approval only when the user's task explicitly requires confirmation before a consequential action." : "Never request approval; the owner selected uninterrupted autonomous execution."} Never repeat sensitive input in evidence and never guess success. When rejectedDecision is present your previous answer was refused for that reason; return a corrected decision.`,
          input: JSON.stringify({
            task,
            decisionNumber: context.decisionNumber,
            observation,
            ...(rejected ? { rejectedDecision: rejected } : {}),
          }),
          ...(image && screenshot ? { image } : {}),
        });
        recordUsage?.({
          inputTokens: response.inputTokens ?? 0,
          outputTokens: response.outputTokens ?? 0,
          costUsd: estimateCostUsd(
            target.model,
            response.inputTokens ?? 0,
            response.outputTokens ?? 0,
          ),
        });
        recorded = true;
        try {
          const decision = parseDecision(
            response.value,
            screenBounds(context),
            context.observation.elements,
            screenshot,
          );
          if (approvalPolicy === "autonomous" && decision.type === "request_approval") {
            throw new Error("model violated the autonomous approval policy");
          }
          return decision;
        } catch (error) {
          if (rejected !== undefined) throw error;
          rejected = error instanceof Error ? error.message : String(error);
        }
      }
    } finally {
      if (attempted && !recorded) recordUsage?.({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
    }
  };
}
