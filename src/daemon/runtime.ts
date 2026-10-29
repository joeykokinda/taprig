import { homedir } from "node:os";
import { join } from "node:path";

import type { AdbDevice } from "../android/adb-discovery.ts";
import { discoverAdbDevices } from "../android/adb-discovery.ts";
import { DeviceRegistry } from "../android/device-actor.ts";
import { TapRigStore } from "../persistence/store.ts";
import { startDaemon } from "./server.ts";

export interface RuntimeOptions {
  token: string;
  discover?: () => Promise<readonly AdbDevice[]>;
  registry?: DeviceRegistry;
  pollIntervalMs?: number;
  databasePath?: string;
}

export function defaultDatabasePath(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (platform === "win32") {
    return join(environment.APPDATA ?? join(home, "AppData", "Roaming"), "TapRig", "taprig.db");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "TapRig", "taprig.db");
  }
  return join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), "taprig", "taprig.db");
}

export interface RunningRuntime {
  url: string;
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const discover = options.discover ?? discoverAdbDevices;
  const registry = options.registry ?? new DeviceRegistry();
  const store = new TapRigStore(options.databasePath ?? defaultDatabasePath());
  let refreshTail = Promise.resolve();
  const refresh = (): Promise<void> => {
    const operation = refreshTail.then(async () => {
      try {
        const devices = await registry.refresh(await discover());
        for (const device of devices) store.saveDevice(device);
      } catch (error) {
        const devices = await registry.refresh([]);
        for (const device of devices) store.saveDevice(device);
        throw error;
      }
    });
    refreshTail = operation.catch(() => undefined);
    return operation;
  };

  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    await refresh();
    daemon = await startDaemon({ token: options.token, devices: registry });
  } catch (error) {
    store.close();
    throw error;
  }
  const timer = setInterval(
    () => void refresh().catch(() => undefined),
    options.pollIntervalMs ?? 1000,
  );
  timer.unref();

  return {
    url: daemon.url,
    refresh,
    async stop() {
      clearInterval(timer);
      await refreshTail;
      try {
        await daemon.stop();
      } finally {
        store.close();
      }
    },
  };
}
