import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileAppNotes } from "../agents/app-notes.ts";
import { createModelCoordinator } from "../agents/model-coordinator.ts";
import { createModelDecider } from "../agents/model-decider.ts";
import type { AdbDevice } from "../android/adb-discovery.ts";
import { discoverAdbDevices } from "../android/adb-discovery.ts";
import { ensureAdbOnPath } from "../android/adb-install.ts";
import { DeviceRegistry } from "../android/device-actor.ts";
import {
  AndroidDriverManager,
  createAdbDriverHost,
  loadDriverBundle,
} from "../android/driver/session.ts";
import { AndroidDriverAdapter } from "../android/driver-adapter.ts";
import { listNotifications } from "../android/notifications.ts";
import {
  executeManualText,
  executeNormalizedTap,
  executeRawAction,
  listThirdPartyPackages,
} from "../android/raw-actions.ts";
import { startScreenRecording } from "../android/screenrecord.ts";
import { captureAdbScreenshot } from "../android/screenshot.ts";
import { AndroidSemanticAdapter } from "../android/semantic-adapter.ts";
import { lockPortrait, unlockWithPin, wakeAndSwipe } from "../android/unlock.ts";
import { ArtifactService } from "../artifacts/service.ts";
import { DeviceGroupService } from "../devices/groups.ts";
import { detectProvider, loadOrCreateModelConfig, usableModelConfig } from "../models/config.ts";
import { providerReady, providerRequirement } from "../models/providers.ts";
import { routeModel } from "../models/router.ts";
import { dataDirectory } from "../paths.ts";
import { TapRigStore } from "../persistence/store.ts";
import { ScheduleService } from "../runs/schedules.ts";
import { RunService } from "../runs/service.ts";
import { TriggerService } from "../runs/triggers.ts";
import { RunWorker } from "../runs/worker.ts";
import { ScriptService } from "../scripts/service.ts";
import { ScriptStore } from "../scripts/store.ts";
import { CredentialBroker } from "../security/credential-broker.ts";
import { SecretStore } from "../security/secret-store.ts";
import { SettingsService } from "../settings.ts";
import { startLiveMjpegStream } from "../video/live-stream.ts";
import { startDaemon } from "./server.ts";

export interface RuntimeOptions {
  token: string;
  discover?: () => Promise<readonly AdbDevice[]>;
  registry?: DeviceRegistry;
  pollIntervalMs?: number;
  databasePath?: string;
  driverBundleDirectory?: string;
}

// A source checkout or npm install carries the bundle built by `npm run build:driver`.
function installedDriverBundle(): string | undefined {
  const directory = fileURLToPath(new URL("../../android-driver/build/bundle", import.meta.url));
  return existsSync(join(directory, "manifest.json")) ? directory : undefined;
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
  for (const run of runs.active()) {
    if (run.status === "created") {
      const targets = run.affinity?.deviceIds ?? [];
      const affinityReady =
        targets.length === 0 ||
        (run.mode === "broadcast"
          ? targets.every((id) => ready.has(id))
          : targets.some((id) => ready.has(id)));
      if (affinityReady) worker.start(run.id);
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
    const affinityTargets = run.affinity?.deviceIds ?? [];
    const affinityReady =
      affinityTargets.length === 0 ||
      (run.mode === "broadcast"
        ? affinityTargets.every((id) => ready.has(id))
        : affinityTargets.some((id) => ready.has(id)));
    if (affinityReady && [...deviceIds, ...pinned].every((id) => ready.has(id))) {
      worker.recover(run.id);
    }
  }
}

async function bundleModified(directory: string): Promise<number> {
  return stat(join(directory, "manifest.json"))
    .then((info) => info.mtimeMs)
    .catch(() => 0);
}

export async function startRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  // Every adb call in the daemon resolves through PATH, so one download covers all of them.
  if (!options.discover) await ensureAdbOnPath();
  const discover = options.discover ?? discoverAdbDevices;
  const registry = options.registry ?? new DeviceRegistry();
  const databasePath = options.databasePath ?? defaultDatabasePath();
  const store = new TapRigStore(databasePath);
  const artifacts = new ArtifactService(join(dirname(databasePath), "artifacts"), store);
  const settings = new SettingsService(join(dirname(databasePath), "settings.json"));
  const runs = new RunService(store);
  const groups = new DeviceGroupService(store);
  // An empty TAPRIG_DRIVER_DIR turns the driver off and keeps every phone on UIAutomator.
  const configuredBundle = options.driverBundleDirectory ?? process.env.TAPRIG_DRIVER_DIR;
  const driverBundleDirectory =
    configuredBundle === "" ? undefined : (configuredBundle ?? installedDriverBundle());
  // Without a verified bundle every phone stays on the UIAutomator fallback.
  const drivers = driverBundleDirectory
    ? new AndroidDriverManager({
        ...(await loadDriverBundle(driverBundleDirectory)),
        host: createAdbDriverHost(process.env.TAPRIG_ADB ?? "adb"),
        onEnrollmentError: (serial, error) =>
          console.error(
            `taprig: ${serial} driver enrollment failed, using UIAutomator fallback: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      })
    : undefined;
  const semanticAdapter = drivers
    ? new AndroidDriverAdapter(drivers, new AndroidSemanticAdapter())
    : new AndroidSemanticAdapter();
  let driverSync = Promise.resolve();
  let bundleStamp = driverBundleDirectory ? await bundleModified(driverBundleDirectory) : 0;
  const syncDrivers = (devices: readonly { serial: string; state: string }[]) => {
    if (!drivers || !driverBundleDirectory) return;
    const ready = devices.filter((device) => device.state === "ready").map(({ serial }) => serial);
    driverSync = driverSync.then(async () => {
      // A rebuilt bundle re-enrolls every phone without a daemon restart.
      const stamp = await bundleModified(driverBundleDirectory);
      if (stamp !== bundleStamp) {
        bundleStamp = stamp;
        await drivers.reload(await loadDriverBundle(driverBundleDirectory));
      }
      await drivers.sync(ready);
    });
  };
  const scripts = new ScriptService(
    new ScriptStore(join(dirname(databasePath), "scripts")),
    semanticAdapter,
  );
  const usable = usableModelConfig(
    loadOrCreateModelConfig(join(dirname(databasePath), "models.json")),
    (candidate) => providerReady(candidate),
  );
  const modelConfig = usable.config;
  if (usable.switchedTo) {
    console.error(`taprig: configured model provider is unavailable; using ${usable.switchedTo}`);
  }
  const route = routeModel(modelConfig, "fast", { strongCalls: 0, visionCalls: 0 });
  const coordinatorRoute =
    routeModel(modelConfig, "strong", { strongCalls: 0, visionCalls: 0 }) ?? route;
  const provider = route ? modelConfig.providers[route.target.provider] : undefined;
  const coordinatorProvider = coordinatorRoute
    ? modelConfig.providers[coordinatorRoute.target.provider]
    : undefined;
  const appNotes = new FileAppNotes(join(dirname(databasePath), "app-notes"));
  const schedules = new ScheduleService(join(dirname(databasePath), "schedules.json"));
  const triggers = new TriggerService(join(dirname(databasePath), "triggers.json"));
  const secrets = new SecretStore(join(dirname(databasePath), "secrets.json"));
  let lastTriggerPoll = 0;
  const worker =
    route && provider && providerReady(provider)
      ? new RunWorker({
          runs,
          devices: registry,
          adapter: semanticAdapter,
          prepare: async (deviceId) => {
            // A phone that just unlocked is still enrolling its driver; a run that starts before
            // that finishes would silently land on the UIAutomator fallback.
            await driverSync;
            await lockPortrait(deviceId);
          },
          cleanup: (deviceId) => executeRawAction(deviceId, { type: "key.press", key: "home" }),
          secrets,
          wake: async (deviceId) => {
            // Environment first; otherwise the 0600 secret store, so `taprig secret set unlock-pin`
            // survives daemon restarts like every other named secret.
            const pin =
              process.env[`TAPRIG_UNLOCK_PIN_${deviceId}`] ??
              process.env.TAPRIG_UNLOCK_PIN ??
              secrets.get(`unlock-pin.${deviceId}`) ??
              secrets.get("unlock-pin");
            if (pin) {
              const broker = new CredentialBroker();
              const scope = { deviceId, purpose: "device.unlock" };
              await unlockWithPin({
                serial: deviceId,
                credential: broker.store(pin, scope, { oneTime: true }),
                broker,
              });
            } else await wakeAndSwipe(deviceId);
            await new Promise((resolve) => setTimeout(resolve, 800));
            await refresh();
          },
          decide: (task, recordUsage) =>
            createModelDecider(
              task,
              route.target,
              provider,
              process.env,
              fetch,
              recordUsage,
              settings.get().approvalPolicy,
              captureAdbScreenshot,
              listThirdPartyPackages,
              settings.get().vision,
              appNotes,
              listNotifications,
            ),
          ...(coordinatorRoute && coordinatorProvider && providerReady(coordinatorProvider)
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
          captureArtifact: (runId, deviceId) =>
            artifacts.screenshot(runId, deviceId).then(() => undefined),
          record: async (runId, deviceId) => {
            if (!settings.get().recordVideo) return async () => undefined;
            const reserved = await artifacts.videoPath(runId);
            const recording = startScreenRecording(deviceId, process.env.TAPRIG_ADB ?? "adb");
            return async () => {
              const bytes = await recording.stop(reserved.path);
              if (bytes > 0) artifacts.video(runId, deviceId, reserved, bytes);
            };
          },
        })
      : undefined;
  let schedulingEnabled = false;
  let discoveryError: string | undefined;
  let refreshTail = Promise.resolve();
  const refresh = (): Promise<void> => {
    const operation = refreshTail.then(async () => {
      try {
        const devices = await registry.refresh(await discover());
        discoveryError = undefined;
        for (const device of devices) store.saveDevice(device);
        syncDrivers(devices);
        if (worker && schedulingEnabled) {
          scheduleDurableRuns(runs, worker, devices);
          for (const schedule of schedules.due()) {
            worker.start(runs.create(schedule.task, schedule.mode).id);
          }
          // The shade is polled a few times a minute; dumpsys on every tick would be too much.
          if (Date.now() - lastTriggerPoll >= 15_000) {
            lastTriggerPoll = Date.now();
            for (const device of devices.filter((candidate) => candidate.state === "ready")) {
              const shade = await listNotifications(device.serial).catch(() => undefined);
              if (!shade) continue;
              for (const task of triggers.fire(device.serial, shade)) {
                worker.start(runs.create(task).id);
              }
            }
          }
        }
      } catch (error) {
        discoveryError = error instanceof Error ? error.message : String(error);
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
    // A missing adb must not stop the daemon: setup reports it, and polling recovers once installed.
    await refresh().catch(() => undefined);
    daemon = await startDaemon({
      discoveryError: () => discoveryError,
      token: options.token,
      devices: registry,
      execute: executeRawAction,
      observe: (deviceId) => semanticAdapter.observe(deviceId),
      executeBatch: (batch) => semanticAdapter.execute(batch),
      screenshot: captureAdbScreenshot,
      ...(worker ? { deviceBusy: (deviceId: string) => worker.busy(deviceId) } : {}),
      groups,
      artifacts,
      settings,
      runs,
      ...(worker
        ? {
            startRun: (runId: string, deviceId?: string) => worker.start(runId, deviceId),
            continueRun: (runId: string) => worker.resumePaused(runId),
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
      manualText: executeManualText,
      notifications: listNotifications,
      schedules,
      triggers,
      secrets,
      modelProfile: modelConfig.selectedProfile,
      ...(route ? { modelProvider: route.target.provider } : {}),
      modelRequirement:
        provider && !providerReady(provider) && detectProvider() === undefined
          ? "set ANTHROPIC_API_KEY or OPENAI_API_KEY, or sign in to the claude or codex CLI"
          : provider
            ? providerRequirement(provider)
            : "configure a model provider",
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
        await driverSync;
        await drivers?.close();
      } finally {
        store.close();
      }
    },
  };
}
