import type {
  ActionBatch,
  BatchResult,
  DeviceAdapter,
  DeviceId,
  Observation,
} from "../core/contracts.ts";

export interface AndroidDriverProvider {
  get(deviceId: DeviceId): DeviceAdapter | undefined;
}

export class AndroidDriverAdapter implements DeviceAdapter {
  readonly #drivers: AndroidDriverProvider;
  readonly #fallback: DeviceAdapter;

  constructor(drivers: AndroidDriverProvider, fallback: DeviceAdapter) {
    this.#drivers = drivers;
    this.#fallback = fallback;
  }

  observe(deviceId: DeviceId): Promise<Observation> {
    return (this.#drivers.get(deviceId) ?? this.#fallback).observe(deviceId);
  }

  execute(batch: ActionBatch): Promise<BatchResult> {
    return (this.#drivers.get(batch.deviceId) ?? this.#fallback).execute(batch);
  }
}
