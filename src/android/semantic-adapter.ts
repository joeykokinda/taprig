import type {
  Action,
  ActionBatch,
  BatchResult,
  DeviceAdapter,
  DeviceId,
  Observation,
  StepResult,
  TapRigError,
} from "../core/contracts.ts";
import { executeRawAction } from "./raw-actions.ts";
import { observeSemantics, tapSemanticElement, typeSemanticElement } from "./semantic.ts";

type Observe = (deviceId: DeviceId) => Promise<Observation>;
type Tap = typeof tapSemanticElement;
type Text = typeof typeSemanticElement;
type Raw = (deviceId: DeviceId, action: Action) => Promise<void>;

export function needsExactScreen(action: Action): boolean {
  if (action.type === "gesture.tap") return true;
  return "target" in action && "elementId" in action.target;
}

function failure(code: TapRigError["code"], message: string): TapRigError {
  return { code, message, retryable: code === "verification-failed" };
}

export class AndroidSemanticAdapter implements DeviceAdapter {
  readonly #results = new Map<string, BatchResult>();
  readonly #observe: Observe;
  readonly #tap: Tap;
  readonly #text: Text;
  readonly #raw: Raw;

  constructor(
    observe: Observe = observeSemantics,
    tap: Tap = tapSemanticElement,
    raw: Raw = executeRawAction,
    text: Text = typeSemanticElement,
  ) {
    this.#observe = observe;
    this.#tap = tap;
    this.#raw = raw;
    this.#text = text;
  }

  observe(deviceId: DeviceId): Promise<Observation> {
    return this.#observe(deviceId);
  }

  async execute(batch: ActionBatch): Promise<BatchResult> {
    const key = `${batch.deviceId}:${batch.requestId}`;
    const previous = this.#results.get(key);
    if (previous) return { ...previous, replayed: true };

    // Same rule as the driver: semantic selectors resolve against this fresh observation, so only
    // coordinates and positional element IDs require the exact screen the planner saw.
    let observation = await this.observe(batch.deviceId);
    if (
      observation.generation !== batch.observationGeneration &&
      batch.steps.some(({ action }) => needsExactScreen(action))
    ) {
      throw new Error(`stale observation ${batch.observationGeneration}`);
    }

    const steps: StepResult[] = [];
    let stopped = false;
    for (const step of batch.steps) {
      const startedAt = performance.now();
      if (stopped) {
        steps.push({ stepId: step.id, status: "skipped", durationMs: 0 });
        continue;
      }
      if (step.action.type === "element.longTap") {
        steps.push({
          stepId: step.id,
          status: "failed",
          durationMs: performance.now() - startedAt,
          error: failure("unsupported-action", `${step.action.type} is not implemented`),
        });
        stopped = true;
        continue;
      }

      try {
        if (step.action.type === "element.tap") {
          await this.#tap(batch.deviceId, observation, step.action.target);
        } else if (step.action.type === "element.text") {
          await this.#text(
            batch.deviceId,
            observation,
            step.action.target,
            step.action.value,
            step.action.clear ?? false,
          );
        } else {
          await this.#raw(batch.deviceId, step.action);
        }
        const next = await this.observe(batch.deviceId);
        // Taps and keys count as delivered; only text entry and swipes must visibly change the tree.
        if (
          next.generation === observation.generation &&
          step.action.type !== "element.tap" &&
          step.action.type !== "key.press" &&
          step.action.type !== "gesture.tap" &&
          step.action.type !== "app.launch"
        ) {
          throw new Error("semantic observation did not change after action");
        }
        observation = next;
        steps.push({
          stepId: step.id,
          status: "verified",
          durationMs: performance.now() - startedAt,
        });
      } catch (error) {
        steps.push({
          stepId: step.id,
          status: "failed",
          durationMs: performance.now() - startedAt,
          error: failure(
            "verification-failed",
            error instanceof Error ? error.message : String(error),
          ),
        });
        stopped = true;
      }
    }

    const result: BatchResult = {
      requestId: batch.requestId,
      deviceId: batch.deviceId,
      steps,
      replayed: false,
    };
    this.#results.set(key, result);
    return result;
  }
}
