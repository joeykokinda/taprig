import { dirname, join } from "node:path";

import { createModelDecider } from "../agents/model-decider.ts";
import type { AdbDevice } from "../android/adb-discovery.ts";
import { discoverAdbDevices } from "../android/adb-discovery.ts";
import { DeviceRegistry } from "../android/device-actor.ts";
import { executeNormalizedTap, executeRawAction } from "../android/raw-actions.ts";
import { AndroidSemanticAdapter } from "../android/semantic-adapter.ts";
import { loadOrCreateModelConfig } from "../models/config.ts";
import { routeModel } from "../models/router.ts";
import { dataDirectory } from "../paths.ts";
import { TapRigStore } from "../persistence/store.ts";
import { RunService } from "../runs/service.ts";
import { RunWorker } from "../runs/worker.ts";
import { ScriptService } from "../scripts/service.ts";
import { ScriptStore } from "../scripts/store.ts";
import { startLiveMjpegStream } from "../video/live-stream.ts";
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
  home?: string,
): string {
  return join(dataDirectory(platform, environment, home), "taprig.db");
}

export interface RunningRuntime {
  url: string;
  refresh(): Promise<void>;
  stop(): Promise<void>;
}

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const discover = options.discover ?? discoverAdbDevices;
  const registry = options.registry ?? new DeviceRegistry();
  const databasePath = options.databasePath ?? defaultDatabasePath();
  const store = new TapRigStore(databasePath);
  const runs = new RunService(store);
  const semanticAdapter = new AndroidSemanticAdapter();
  const scripts = new ScriptService(
    new ScriptStore(join(dirname(databasePath), "scripts")),
    semanticAdapter,
  );
  const modelConfig = loadOrCreateModelConfig(join(dirname(databasePath), "models.json"));
  const route = routeModel(modelConfig, "fast", { strongCalls: 0, visionCalls: 0 });
  const provider = route ? modelConfig.providers[route.target.provider] : undefined;
  const worker =
    route && provider && process.env[provider.apiKeyEnv]
      ? new RunWorker({
          runs,
          devices: registry,
          adapter: semanticAdapter,
          decide: (task) => createModelDecider(task, route.target, provider),
        })
      : undefined;
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
    daemon = await startDaemon({
      token: options.token,
      devices: registry,
      execute: executeRawAction,
      runs,
      ...(worker ? { startRun: (runId: string) => worker.start(runId) } : {}),
      scripts,
      stream: (serial) =>
        startLiveMjpegStream({
          serial,
          scrcpyExecutable: process.env.TAPRIG_SCRCPY ?? "scrcpy",
          adbExecutable: process.env.TAPRIG_ADB ?? "adb",
        }),
      manualTap: executeNormalizedTap,
    });
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
        await worker?.idle();
        await daemon.stop();
      } finally {
        store.close();
      }
    },
  };
}
