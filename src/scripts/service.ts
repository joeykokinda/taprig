import type { DeviceAdapter } from "../core/contracts.ts";
import type { ScriptRunResult, TapRigScript } from "./contracts.ts";
import { runScript } from "./engine.ts";
import { type ScriptStore, validateScript } from "./store.ts";

export class ScriptService {
  readonly store: ScriptStore;
  readonly device: DeviceAdapter;

  constructor(store: ScriptStore, device: DeviceAdapter) {
    this.store = store;
    this.device = device;
  }

  create(value: unknown): TapRigScript {
    const script = validateScript(value as TapRigScript);
    this.store.save(script);
    return script;
  }

  list(): TapRigScript[] {
    return this.store.list();
  }

  get(id: string): TapRigScript | undefined {
    return this.store.get(id);
  }

  async run(
    id: string,
    deviceId: string,
    inputs: Readonly<Record<string, string>>,
  ): Promise<ScriptRunResult> {
    const script = this.store.get(id);
    if (!script) throw new Error(`script ${id} not found`);
    if (!deviceId) throw new Error("script run requires a device ID");
    if (Object.values(inputs).some((value) => typeof value !== "string")) {
      throw new Error("script inputs must be strings");
    }
    return runScript(script, inputs, this.device, deviceId);
  }
}
