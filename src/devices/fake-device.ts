import type {
  ActionBatch,
  BatchResult,
  DeviceAdapter,
  DeviceId,
  Observation,
  StepResult,
} from "../core/contracts.ts";

export class FakeDeviceAdapter implements DeviceAdapter {
  readonly #observations = new Map<DeviceId, Observation>();
  readonly #results = new Map<string, BatchResult>();

  setObservation(observation: Observation): void {
    this.#observations.set(observation.deviceId, observation);
  }

  async observe(deviceId: DeviceId): Promise<Observation> {
    const observation = this.#observations.get(deviceId);
    if (!observation) throw new Error(`fake device ${deviceId} has no observation`);
    return observation;
  }

  async execute(batch: ActionBatch): Promise<BatchResult> {
    const key = `${batch.deviceId}:${batch.requestId}`;
    const existing = this.#results.get(key);
    if (existing) return { ...existing, replayed: true };

    const observation = await this.observe(batch.deviceId);
    if (observation.generation !== batch.observationGeneration) {
      throw new Error(`stale observation ${batch.observationGeneration}`);
    }

    const steps: StepResult[] = batch.steps.map((step) => ({
      stepId: step.id,
      status: "verified",
      durationMs: 0,
    }));
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
