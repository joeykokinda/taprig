import type { AdbDevice } from "../android/adb-discovery.ts";
import { discoverAdbDevices } from "../android/adb-discovery.ts";
import { DeviceRegistry } from "../android/device-actor.ts";
import { startDaemon } from "./server.ts";

export interface RuntimeOptions {
  token: string;
  discover?: () => Promise<readonly AdbDevice[]>;
  registry?: DeviceRegistry;
  pollIntervalMs?: number;
}

export interface RunningRuntime {
  url: string;
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const discover = options.discover ?? discoverAdbDevices;
  const registry = options.registry ?? new DeviceRegistry();
  let refreshTail = Promise.resolve();
  const refresh = (): Promise<void> => {
    const operation = refreshTail.then(async () => {
      try {
        await registry.refresh(await discover());
      } catch (error) {
        await registry.refresh([]);
        throw error;
      }
    });
    refreshTail = operation.catch(() => undefined);
    return operation;
  };

  await refresh();
  const daemon = await startDaemon({ token: options.token, devices: registry });
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
      await daemon.stop();
    },
  };
}
