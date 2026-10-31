import { pathToFileURL } from "node:url";

import { runAgentLoop } from "../agents/loop.ts";
import type { ActionBatch, BatchResult, DeviceAdapter, Observation } from "../core/contracts.ts";
import { runBroadcast } from "../orchestration/broadcast.ts";
import { runCoordinated } from "../orchestration/coordinated.ts";

export interface BenchmarkResult {
  scenario: string;
  mode: "independent" | "broadcast" | "coordinated";
  fleetSize: number;
  iterations: number;
  successes: number;
  successRate: number;
  meanMs: number;
  p95Ms: number;
  meanDecisionCalls: number;
  meanDeviceActions: number;
  meanWorkUnits: number;
}

interface Sample {
  success: boolean;
  elapsedMs: number;
  decisionCalls: number;
  deviceActions: number;
  workUnits: number;
}

type Scenario = {
  name: string;
  mode: BenchmarkResult["mode"];
  fleetSize: number;
  run(): Promise<Omit<Sample, "elapsedMs">>;
};

const observation = (deviceId: string, generation: string): Observation => ({
  deviceId,
  generation,
  capturedAt: "2026-01-01T00:00:00.000Z",
  elements: [],
});

function simulatedDevice(deviceIds: readonly string[], metric: { actions: number }): DeviceAdapter {
  const generations = new Map(deviceIds.map((id) => [id, "before"]));
  return {
    observe: async (deviceId) => observation(deviceId, generations.get(deviceId) ?? "missing"),
    execute: async (batch: ActionBatch): Promise<BatchResult> => {
      metric.actions += batch.steps.length;
      generations.set(batch.deviceId, "after");
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
}

function independentScenario(fleetSize: number): Scenario {
  return {
    name: `independent-${fleetSize}`,
    mode: "independent",
    fleetSize,
    async run() {
      const ids = Array.from({ length: fleetSize }, (_, index) => `phone-${index + 1}`);
      const metric = { actions: 0, decisions: 0 };
      const device = simulatedDevice(ids, metric);
      const results = await Promise.all(
        ids.map((deviceId) =>
          runAgentLoop({
            device,
            deviceId,
            verifyCompletion: async () => undefined,
            decide: async ({ decisionNumber }) => {
              metric.decisions += 1;
              return decisionNumber === 0
                ? {
                    type: "execute",
                    requestId: `request-${deviceId}`,
                    steps: [
                      {
                        id: "open",
                        action: { type: "app.launch", packageName: "com.android.settings" },
                      },
                    ],
                  }
                : { type: "complete", evidence: "complete" };
            },
          }),
        ),
      );
      return {
        success: results.every((result) => result.status === "completed"),
        decisionCalls: metric.decisions,
        deviceActions: metric.actions,
        workUnits: fleetSize,
      };
    },
  };
}

function broadcastScenario(fleetSize: number): Scenario {
  return {
    name: `broadcast-${fleetSize}`,
    mode: "broadcast",
    fleetSize,
    async run() {
      const ids = Array.from({ length: fleetSize }, (_, index) => `phone-${index + 1}`);
      const metric = { actions: 0, decisions: 0 };
      const device = simulatedDevice(ids, metric);
      const result = await runBroadcast({
        device,
        deviceIds: ids,
        decide: async ({ decisionNumber }) => {
          metric.decisions += 1;
          return decisionNumber === 0
            ? {
                type: "execute",
                requestId: "broadcast",
                steps: [
                  {
                    id: "open",
                    action: { type: "app.launch", packageName: "com.android.settings" },
                  },
                ],
              }
            : { type: "complete", evidence: "complete" };
        },
        recover: async (deviceId) => ({
          status: "completed",
          evidence: `${deviceId} complete`,
          decisions: 0,
          actions: [],
        }),
      });
      return {
        success: result.status === "completed",
        decisionCalls: metric.decisions,
        deviceActions: metric.actions,
        workUnits: fleetSize,
      };
    },
  };
}

function coordinatedScenario(fleetSize: number): Scenario {
  return {
    name: `coordinated-${fleetSize}`,
    mode: "coordinated",
    fleetSize,
    async run() {
      const roots = Array.from({ length: fleetSize }, (_, index) => ({
        id: `work-${index + 1}`,
        task: `Work ${index + 1}`,
        dependsOn: [] as string[],
      }));
      let workUnits = 0;
      const result = await runCoordinated({
        plan: {
          nodes: [
            ...roots,
            { id: "aggregate", task: "Aggregate", dependsOn: roots.map((node) => node.id) },
          ],
        },
        execute: async (node) => {
          workUnits += 1;
          return {
            id: node.id,
            status: "completed",
            deviceId: `phone-${(workUnits % fleetSize) + 1}`,
            evidence: "complete",
            actions: [],
          };
        },
      });
      return {
        success: result.status === "completed",
        decisionCalls: 0,
        deviceActions: 0,
        workUnits,
      };
    },
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

async function measure(scenario: Scenario, iterations: number): Promise<BenchmarkResult> {
  const samples: Sample[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    const result = await scenario.run();
    samples.push({ ...result, elapsedMs: performance.now() - started });
  }
  const latencies = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
  const successes = samples.filter((sample) => sample.success).length;
  const mean = (field: "elapsedMs" | "decisionCalls" | "deviceActions" | "workUnits") =>
    samples.reduce((total, sample) => total + sample[field], 0) / samples.length;
  return {
    scenario: scenario.name,
    mode: scenario.mode,
    fleetSize: scenario.fleetSize,
    iterations,
    successes,
    successRate: round(successes / iterations),
    meanMs: round(mean("elapsedMs")),
    p95Ms: round(latencies[Math.ceil(latencies.length * 0.95) - 1] ?? 0),
    meanDecisionCalls: round(mean("decisionCalls")),
    meanDeviceActions: round(mean("deviceActions")),
    meanWorkUnits: round(mean("workUnits")),
  };
}

export async function runRuntimeBenchmarks(iterations = 50): Promise<BenchmarkResult[]> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10_000) {
    throw new Error("iterations must be an integer from 1 to 10000");
  }
  const scenarios = [
    independentScenario(1),
    independentScenario(4),
    independentScenario(16),
    broadcastScenario(2),
    broadcastScenario(8),
    coordinatedScenario(2),
    coordinatedScenario(8),
  ];
  const results: BenchmarkResult[] = [];
  for (const scenario of scenarios) results.push(await measure(scenario, iterations));
  return results;
}

function printTable(results: readonly BenchmarkResult[]): void {
  console.table(
    results.map((result) => ({
      scenario: result.scenario,
      success: `${Math.round(result.successRate * 100)}%`,
      meanMs: result.meanMs,
      p95Ms: result.p95Ms,
      decisions: result.meanDecisionCalls,
      actions: result.meanDeviceActions,
      workUnits: result.meanWorkUnits,
    })),
  );
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const rawIterations = process.argv.find((argument) => argument.startsWith("--iterations="));
  const iterations = rawIterations ? Number(rawIterations.slice("--iterations=".length)) : 50;
  const results = await runRuntimeBenchmarks(iterations);
  if (json)
    process.stdout.write(`${JSON.stringify({ kind: "synthetic-runtime", results }, null, 2)}\n`);
  else printTable(results);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
