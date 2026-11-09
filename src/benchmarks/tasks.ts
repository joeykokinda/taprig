// Repeats a pinned task matrix on a real phone through the running daemon and writes
// raw runs plus a summary. Success is judged against the phone itself (adb), never
// against the model's own claim of completion.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { daemonRequest } from "../daemon/lifecycle.ts";

const exec = promisify(execFile);

interface BenchTask {
  name: string;
  task: string;
  /** Returns a pattern the run's result must match, derived from the phone's real state. */
  expected(adb: (...args: string[]) => Promise<string>): Promise<RegExp>;
}

export const tasks: readonly BenchTask[] = [
  {
    name: "settings-android-version",
    task: "Open Settings, find the Android version of this phone, and end your report with 'Answer: <version number>'.",
    async expected(adb) {
      const release = (await adb("shell", "getprop", "ro.build.version.release")).trim();
      return new RegExp(`Answer:\\s*${release.replace(/\./gu, "\\.")}\\b`, "iu");
    },
  },
  {
    name: "settings-dark-theme",
    task: "Open Settings, go to Display, check whether Dark theme is on, and end your report with 'Answer: on' or 'Answer: off'.",
    async expected(adb) {
      const on = /yes/u.test(await adb("shell", "cmd", "uimode", "night"));
      return on ? /Answer:\s*on\b/iu : /Answer:\s*off\b/iu;
    },
  },
  {
    name: "chrome-read-heading",
    task: "Open Chrome, go to example.com, and end your report with 'Answer: <the page's main heading>'.",
    expected: async () => /Answer:\s*"?Example Domain/iu,
  },
];

interface Telemetry {
  elapsedMs?: number;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  attemptedActions?: number;
}

interface Trial {
  task: string;
  runId: string;
  status: string;
  success: boolean;
  wallMs: number;
  result: string;
  telemetry: Telemetry;
}

async function daemonJson<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await daemonRequest(route, init);
  if (!response.ok) throw new Error(`daemon returned HTTP ${response.status} for ${route}`);
  return (await response.json()) as T;
}

async function runTrial(device: string, bench: BenchTask, adbPath: string): Promise<Trial> {
  const adb = async (...args: string[]) => (await exec(adbPath, ["-s", device, ...args])).stdout;
  await adb("shell", "input", "keyevent", "KEYCODE_HOME");
  const expected = await bench.expected(adb);
  const started = Date.now();
  const { run } = await daemonJson<{ run: { id: string } }>("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task: bench.task, mode: "independent", deviceIds: [device] }),
  });
  for (;;) {
    const state = await daemonJson<{ run: { status: string }; result?: string }>(`/runs/${run.id}`);
    if (
      ["completed", "failed", "stopped", "waiting-for-user", "paused"].includes(state.run.status)
    ) {
      if (state.run.status === "waiting-for-user" || state.run.status === "paused") {
        await daemonRequest(`/runs/${run.id}/stop`, { method: "POST" });
      }
      // Telemetry is persisted just after the terminal status, so give it a moment.
      let telemetry: Telemetry | null = null;
      for (let attempt = 0; attempt < 10 && !telemetry?.modelCalls; attempt += 1) {
        ({ telemetry } = await daemonJson<{ telemetry: Telemetry | null }>(
          `/runs/${run.id}/telemetry`,
        ));
        if (!telemetry?.modelCalls) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const result = state.result ?? "";
      return {
        task: bench.name,
        runId: run.id,
        status: state.run.status,
        success: state.run.status === "completed" && expected.test(result),
        wallMs: Date.now() - started,
        result,
        telemetry: telemetry ?? {},
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

export function summarize(trials: readonly Trial[]) {
  return [...new Set(trials.map((trial) => trial.task))].map((name) => {
    const rows = trials.filter((trial) => trial.task === name);
    const field = (key: keyof Telemetry) => rows.map((row) => row.telemetry[key] ?? 0);
    return {
      task: name,
      trials: rows.length,
      successRate: rows.filter((row) => row.success).length / rows.length,
      medianMs: percentile(
        rows.map((row) => row.wallMs),
        0.5,
      ),
      p95Ms: percentile(
        rows.map((row) => row.wallMs),
        0.95,
      ),
      meanModelCalls: mean(field("modelCalls")),
      meanTokens: mean(
        rows.map((row) => (row.telemetry.inputTokens ?? 0) + (row.telemetry.outputTokens ?? 0)),
      ),
      meanCostUsd: mean(field("costUsd")),
      meanActions: mean(field("attemptedActions")),
    };
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const device = option("--device");
  if (!device)
    throw new Error("usage: npm run benchmark:tasks -- --device <serial> [--trials 5] [--out dir]");
  const trialCount = Number(option("--trials") ?? 5);
  const adbPath = process.env.ADB ?? "adb";
  const adb = async (...extra: string[]) =>
    (await exec(adbPath, ["-s", device, ...extra])).stdout.trim();
  const { stdout: commit } = await exec("git", ["rev-parse", "--short", "HEAD"]).catch(() => ({
    stdout: "unknown",
  }));
  const { stdout: model } = await exec(process.execPath, [
    path.join(import.meta.dirname, "../cli.ts"),
    "model",
    "show",
  ]);
  const environment = {
    capturedAt: new Date().toISOString(),
    commit: commit.trim(),
    device: {
      serial: device,
      model: await adb("shell", "getprop", "ro.product.model"),
      android: await adb("shell", "getprop", "ro.build.version.release"),
    },
    modelConfig: model.trim(),
  };
  const trials: Trial[] = [];
  for (let round = 0; round < trialCount; round += 1) {
    for (const bench of tasks) {
      const trial = await runTrial(device, bench, adbPath);
      trials.push(trial);
      process.stdout.write(
        `${trial.task}\t${trial.status}\t${trial.success ? "pass" : "FAIL"}\t${trial.wallMs}ms\t$${(trial.telemetry.costUsd ?? 0).toFixed(4)}\n`,
      );
    }
  }
  const summary = summarize(trials);
  const outDir =
    option("--out") ??
    path.join(
      "benchmarks",
      "results",
      `${environment.commit}-${environment.device.model.replace(/\W+/gu, "-")}`,
    );
  await mkdir(outDir, { recursive: true });
  await writeFile(
    path.join(outDir, "tasks.json"),
    `${JSON.stringify({ environment, summary, trials }, null, 2)}\n`,
  );
  console.table(summary);
  process.stdout.write(`Wrote ${outDir}/tasks.json\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
