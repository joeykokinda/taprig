import { dirname, join } from "node:path";
import { createModelCoordinator } from "../agents/model-coordinator.ts";
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

interface DurableRunWorker {
  start(runId: string): void;
  recover(runId: string): void;
}

export function scheduleDurableRuns(
  runs: RunService,
  worker: DurableRunWorker,
  devices: readonly { id: string; state: string }[],
): void {
  const ready = new Set(devices.filter((device) => device.state === "ready").map(({ id }) => id));
  if (ready.size === 0) return;
  for (const run of runs.list().reverse()) {
    if (run.status === "created") {
      worker.start(run.id);
      continue;
    }
    if (run.status !== "running") continue;
    const stored = runs.recovery(run.id)?.evidence as
      | { deviceIds?: unknown; plan?: { nodes?: unknown }; nodes?: unknown }
      | undefined;
    const deviceIds = Array.isArray(stored?.deviceIds)
      ? stored.deviceIds.filter((id): id is string => typeof id === "string")
      : [];
    const completed = new Set(
      Array.isArray(stored?.nodes)
        ? stored.nodes.flatMap((node) =>
            node &&
            typeof node === "object" &&
            "id" in node &&
            typeof node.id === "string" &&
            "status" in node &&
            node.status === "completed"
              ? [node.id]
              : [],
          )
        : [],
    );
    const pinned = Array.isArray(stored?.plan?.nodes)
      ? stored.plan.nodes.flatMap((node) =>
          node &&
          typeof node === "object" &&
          "id" in node &&
          typeof node.id === "string" &&
          !completed.has(node.id) &&
          "deviceId" in node &&
          typeof node.deviceId === "string"
            ? [node.deviceId]
            : [],
        )
      : [];
    if ([...deviceIds, ...pinned].every((id) => ready.has(id))) worker.recover(run.id);
  }
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
  const coordinatorRoute =
    routeModel(modelConfig, "strong", { strongCalls: 0, visionCalls: 0 }) ?? route;
  const provider = route ? modelConfig.providers[route.target.provider] : undefined;
  const coordinatorProvider = coordinatorRoute
    ? modelConfig.providers[coordinatorRoute.target.provider]
    : undefined;
  const worker =
    route && provider && process.env[provider.apiKeyEnv]
      ? new RunWorker({
          runs,
          devices: registry,
          adapter: semanticAdapter,
          decide: (task, recordUsage) =>
            createModelDecider(task, route.target, provider, process.env, fetch, recordUsage),
          ...(coordinatorRoute && coordinatorProvider && process.env[coordinatorProvider.apiKeyEnv]
            ? {
                planCoordinated: (task, recordUsage) =>
                  createModelCoordinator(
                    coordinatorRoute.target,
                    coordinatorProvider,
                    process.env,
                    fetch,
                    recordUsage,
                  )(task),
              }
            : {}),
        })
      : undefined;
  let schedulingEnabled = false;
  let refreshTail = Promise.resolve();
  const refresh = (): Promise<void> => {
    const operation = refreshTail.then(async () => {
      try {
        const devices = await registry.refresh(await discover());
        for (const device of devices) store.saveDevice(device);
        if (worker && schedulingEnabled) scheduleDurableRuns(runs, worker, devices);
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
      ...(worker
        ? {
            startRun: (runId: string, deviceId?: string) => worker.start(runId, deviceId),
            resumeRun: (runId: string, answer: Parameters<typeof worker.resume>[1]) =>
              worker.resume(runId, answer),
          }
        : {}),
      scripts,
      stream: (serial) =>
        startLiveMjpegStream({
          serial,
          scrcpyExecutable: process.env.TAPRIG_SCRCPY ?? "scrcpy",
          adbExecutable: process.env.TAPRIG_ADB ?? "adb",
        }),
      manualTap: executeNormalizedTap,
    });
    schedulingEnabled = true;
    if (worker) scheduleDurableRuns(runs, worker, await registry.list());
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
