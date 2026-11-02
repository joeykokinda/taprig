import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ActionBatch, BatchResult, DeviceAdapter, Observation } from "../core/contracts.ts";
import { TapRigStore } from "../persistence/store.ts";
import { RunService } from "../runs/service.ts";
import { RunWorker } from "../runs/worker.ts";

export interface SoakResult {
  kind: "synthetic-runtime-soak";
  iterations: number;
  fleetSize: number;
  completed: number;
  recoveredAfterRestart: number;
  actions: number;
  elapsedMs: number;
  heapDeltaBytes: number;
}

export interface SoakOptions {
  iterations?: number;
  fleetSize?: number;
  restartEvery?: number;
}

function integer(name: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export async function runRuntimeSoak(options: SoakOptions = {}): Promise<SoakResult> {
  const iterations = integer("iterations", options.iterations ?? 1_000, 1, 1_000_000);
  const fleetSize = integer("fleetSize", options.fleetSize ?? 4, 1, 100);
  const restartEvery = integer("restartEvery", options.restartEvery ?? 250, 1, 1_000_000);
  const directory = await mkdtemp(join(tmpdir(), "taprig-soak-"));
  const databasePath = join(directory, "taprig.db");
  const deviceIds = Array.from({ length: fleetSize }, (_, index) => `phone-${index + 1}`);
  const generations = new Map(deviceIds.map((id) => [id, 0]));
  let actions = 0;
  const adapter: DeviceAdapter = {
    observe: async (deviceId): Promise<Observation> => ({
      deviceId,
      generation: String(generations.get(deviceId) ?? 0),
      capturedAt: "2026-01-01T00:00:00.000Z",
      elements: [],
    }),
    execute: async (batch: ActionBatch): Promise<BatchResult> => {
      actions += batch.steps.length;
      generations.set(batch.deviceId, (generations.get(batch.deviceId) ?? 0) + 1);
      return {
        requestId: batch.requestId,
        deviceId: batch.deviceId,
        replayed: false,
        steps: batch.steps.map((step) => ({
          stepId: step.id,
          status: "verified",
          durationMs: 0,
        })),
      };
    },
  };
  const devices = {
    list: async () =>
      deviceIds.map((id) => ({
        id,
        serial: id,
        state: "ready",
        capabilities: ["semantic-observation", "semantic-action"] as const,
      })),
  };
  let store = new TapRigStore(databasePath);
  let runs = new RunService(store);
  const makeWorker = () =>
    new RunWorker({
      runs,
      devices,
      adapter,
      decide:
        () =>
        async ({ decisionNumber, observation }) =>
          decisionNumber === 0
            ? {
                type: "execute",
                requestId: `soak-${observation.deviceId}-${actions}`,
                steps: [{ id: "home", action: { type: "key.press", key: "home" } }],
              }
            : { type: "complete", evidence: "synthetic completion" },
    });
  let worker = makeWorker();
  let completed = 0;
  let recoveredAfterRestart = 0;
  let nextRestart = restartEvery;
  const heapStart = process.memoryUsage().heapUsed;
  const startedAt = performance.now();

  try {
    while (completed < iterations) {
      const wave = Array.from({ length: Math.min(fleetSize, iterations - completed) }, () =>
        runs.create("Synthetic soak task"),
      );
      for (const run of wave) worker.start(run.id);
      await worker.idle();
      for (const run of wave) {
        if (runs.get(run.id)?.status !== "completed") throw new Error(`run ${run.id} failed`);
      }
      completed += wave.length;

      if (completed >= nextRestart && completed < iterations) {
        const interrupted = runs.create("Synthetic restart recovery");
        runs.record(interrupted.id, { type: "run.started", at: new Date().toISOString() });
        runs.saveRecovery(interrupted.id, { deviceIds: [deviceIds[0]] });
        store.close();
        store = new TapRigStore(databasePath);
        runs = new RunService(store);
        worker = makeWorker();
        worker.recover(interrupted.id);
        await worker.idle();
        if (runs.get(interrupted.id)?.status !== "completed") {
          throw new Error(`recovered run ${interrupted.id} failed`);
        }
        recoveredAfterRestart += 1;
        nextRestart += restartEvery;
      }
    }

    return {
      kind: "synthetic-runtime-soak",
      iterations,
      fleetSize,
      completed,
      recoveredAfterRestart,
      actions,
      elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapStart,
    };
  } finally {
    store.close();
    await rm(directory, { recursive: true });
  }
}

async function main(): Promise<void> {
  const value = (name: string) =>
    process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=", 2)[1];
  const result = await runRuntimeSoak({
    ...(value("iterations") ? { iterations: Number(value("iterations")) } : {}),
    ...(value("fleet") ? { fleetSize: Number(value("fleet")) } : {}),
    ...(value("restart-every") ? { restartEvery: Number(value("restart-every")) } : {}),
  });
  process.stdout.write(
    `${JSON.stringify(result, null, process.argv.includes("--json") ? 2 : 0)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
