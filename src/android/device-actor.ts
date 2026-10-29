import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DeviceState } from "../core/contracts.ts";
import type { AdbDevice, AdbTransportState } from "./adb-discovery.ts";

const execFileAsync = promisify(execFile);

export type AdbShell = (serial: string, command: string) => Promise<string>;

export interface AndroidIdentity {
  manufacturer?: string;
  model?: string;
  product?: string;
  androidVersion?: string;
  sdk?: string;
}

export interface DeviceActorState {
  id: string;
  serial: string;
  state: DeviceState;
  transportState: AdbTransportState;
  identity: AndroidIdentity;
  bootCompleted?: boolean;
  unlocked?: boolean;
  observedAt: string;
}

export async function adbShell(serial: string, command: string): Promise<string> {
  const { stdout } = await execFileAsync("adb", ["-s", serial, "shell", command]);
  return stdout;
}

function parseProperties(output: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\[([^\]]+)\]: \[(.*)\]$/u.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) properties.set(match[1], match[2]);
  }
  return properties;
}

export function parseKeyguardUnlocked(output: string): boolean {
  const states = [
    ...output.matchAll(/(?:keyguardShowing|mShowingLockscreen|isStatusBarKeyguard)=(true|false)/gu),
  ];
  return states.length > 0 && states.every((match) => match[1] === "false");
}

async function probeConnectedDevice(
  device: AdbDevice,
  shell: AdbShell,
  observedAt: string,
): Promise<DeviceActorState> {
  const [propertyOutput, windowPolicy] = await Promise.all([
    shell(device.serial, "getprop"),
    shell(device.serial, "dumpsys window policy"),
  ]);
  const properties = parseProperties(propertyOutput);
  const bootCompleted = properties.get("sys.boot_completed") === "1";
  const unlocked = bootCompleted && parseKeyguardUnlocked(windowPolicy);
  const manufacturer = properties.get("ro.product.manufacturer");
  const model = properties.get("ro.product.model");
  const product = properties.get("ro.product.device");
  const androidVersion = properties.get("ro.build.version.release");
  const sdk = properties.get("ro.build.version.sdk");

  return {
    id: device.serial,
    serial: device.serial,
    state: bootCompleted ? (unlocked ? "ready" : "locked") : "booting",
    transportState: device.transportState,
    identity: {
      ...(manufacturer ? { manufacturer } : {}),
      ...(model ? { model } : {}),
      ...(product ? { product } : {}),
      ...(androidVersion ? { androidVersion } : {}),
      ...(sdk ? { sdk } : {}),
    },
    bootCompleted,
    unlocked,
    observedAt,
  };
}

export class DeviceActor {
  readonly #shell: AdbShell;
  readonly #now: () => string;
  #state: DeviceActorState;
  #tail: Promise<DeviceActorState>;

  constructor(serial: string, shell: AdbShell = adbShell, now = () => new Date().toISOString()) {
    this.#shell = shell;
    this.#now = now;
    this.#state = {
      id: serial,
      serial,
      state: "offline",
      transportState: "offline",
      identity: {},
      observedAt: now(),
    };
    this.#tail = Promise.resolve(this.#state);
  }

  refresh(device?: AdbDevice): Promise<DeviceActorState> {
    this.#tail = this.#tail.then(async () => {
      const observedAt = this.#now();
      if (!device) {
        this.#state = {
          ...this.#state,
          state: "offline",
          transportState: "offline",
          observedAt,
        };
      } else if (device.transportState !== "device") {
        this.#state = {
          ...this.#state,
          state: device.transportState === "unauthorized" ? "unauthorized" : "offline",
          transportState: device.transportState,
          observedAt,
        };
      } else {
        try {
          this.#state = await probeConnectedDevice(device, this.#shell, observedAt);
        } catch {
          this.#state = {
            ...this.#state,
            state: "degraded",
            transportState: "device",
            observedAt,
          };
        }
      }
      return this.snapshot();
    });
    return this.#tail;
  }

  snapshot(): DeviceActorState {
    return { ...this.#state, identity: { ...this.#state.identity } };
  }
}

export class DeviceRegistry {
  readonly #actors = new Map<string, DeviceActor>();
  readonly #shell: AdbShell;
  readonly #now: () => string;

  constructor(shell: AdbShell = adbShell, now = () => new Date().toISOString()) {
    this.#shell = shell;
    this.#now = now;
  }

  async refresh(devices: readonly AdbDevice[]): Promise<readonly DeviceActorState[]> {
    const connected = new Map(devices.map((device) => [device.serial, device]));
    for (const device of devices) {
      if (!this.#actors.has(device.serial)) {
        this.#actors.set(device.serial, new DeviceActor(device.serial, this.#shell, this.#now));
      }
    }

    await Promise.all(
      [...this.#actors].map(([serial, actor]) => actor.refresh(connected.get(serial))),
    );
    return this.list();
  }

  async list(): Promise<readonly DeviceActorState[]> {
    return [...this.#actors.values()]
      .map((actor) => actor.snapshot())
      .sort((left, right) => left.serial.localeCompare(right.serial));
  }
}
