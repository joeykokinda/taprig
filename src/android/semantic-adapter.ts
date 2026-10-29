import type {
  ActionBatch,
  BatchResult,
  DeviceAdapter,
  DeviceId,
  Observation,
  StepResult,
  TapRigError,
} from "../core/contracts.ts";
import { observeSemantics, tapSemanticElement } from "./semantic.ts";

type Observe = (deviceId: DeviceId) => Promise<Observation>;
type Tap = typeof tapSemanticElement;

function failure(code: TapRigError["code"], message: string): TapRigError {
  return { code, message, retryable: code === "verification-failed" };
}

export class AndroidSemanticAdapter implements DeviceAdapter {
  readonly #results = new Map<string, BatchResult>();
  readonly #observe: Observe;
  readonly #tap: Tap;

  constructor(observe: Observe = observeSemantics, tap: Tap = tapSemanticElement) {
    this.#observe = observe;
    this.#tap = tap;
  }

  observe(deviceId: DeviceId): Promise<Observation> {
    return this.#observe(deviceId);
  }

  async execute(batch: ActionBatch): Promise<BatchResult> {
    const key = `${batch.deviceId}:${batch.requestId}`;
    const previous = this.#results.get(key);
    if (previous) return { ...previous, replayed: true };

    let observation = await this.observe(batch.deviceId);
    if (observation.generation !== batch.observationGeneration) {
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
      if (step.action.type !== "element.tap") {
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
        await this.#tap(batch.deviceId, observation, step.action.target);
        const next = await this.observe(batch.deviceId);
        if (next.generation === observation.generation) {
          throw new Error("semantic observation did not change after tap");
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
