#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { type AdbDevice, formatAdbDevices } from "./android/adb-discovery.ts";
import type { RunEvent, RunMode, RunState } from "./core/contracts.ts";
import {
  daemonRequest,
  daemonStatus,
  serveDaemon,
  startDaemonProcess,
  stopDaemonProcess,
} from "./daemon/lifecycle.ts";
import { diagnoseAdbDevices, formatDoctorFindings } from "./doctor.ts";
import { parseExecuteCommand } from "./execute-command.ts";
import {
  loadOrCreateModelConfig,
  type ModelProfileName,
  type ModelRole,
  saveModelConfig,
} from "./models/config.ts";
import type { ScriptRunResult, TapRigScript } from "./scripts/contracts.ts";

async function daemonJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await daemonRequest(path, init);
  if (!response.ok) throw new Error(`daemon returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function loadDevices(): Promise<AdbDevice[]> {
  const inventory = await daemonJson<{
    devices: Array<{
      serial: string;
      transportState: AdbDevice["transportState"];
      identity?: { model?: string };
    }>;
  }>("/devices");
  return inventory.devices.map((device) => ({
    serial: device.serial,
    transportState: device.transportState,
    ...(device.identity?.model ? { model: device.identity.model } : {}),
  }));
}

async function createRun(task: string, mode: RunMode = "independent"): Promise<RunState> {
  const result = await daemonJson<{ run: RunState }>("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, mode }),
  });
  return result.run;
}

async function listRuns(): Promise<RunState[]> {
  return (await daemonJson<{ runs: RunState[] }>("/runs")).runs;
}

function printRuns(runs: readonly RunState[]): void {
  if (runs.length === 0) {
    process.stdout.write("No runs yet.\n");
    return;
  }
  for (const run of runs) process.stdout.write(`${run.id}\t${run.status}\t${run.task}\n`);
}

async function showRun(id: string): Promise<void> {
  const [{ run }, { events }] = await Promise.all([
    daemonJson<{ run: RunState }>(`/runs/${encodeURIComponent(id)}`),
    daemonJson<{ events: Array<{ sequence: number; event: RunEvent }> }>(
      `/runs/${encodeURIComponent(id)}/events`,
    ),
  ]);
  process.stdout.write(`${run.id} · ${run.status} · ${run.mode}\n${run.task}\n`);
  for (const item of events) process.stdout.write(`  ${item.sequence}  ${item.event.type}\n`);
}

async function interactiveSession(): Promise<void> {
  const devices = await loadDevices();
  process.stdout.write(
    `TapRig · ${devices.length} device${devices.length === 1 ? "" : "s"} connected\n` +
      "Type a task, or /devices, /runs, /attach <run-id>, /quit.\n\n",
  );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const line = (await terminal.question("› ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") return;
      if (line === "/devices") {
        process.stdout.write(`${formatAdbDevices(await loadDevices())}\n`);
        continue;
      }
      if (line === "/runs") {
        printRuns(await listRuns());
        continue;
      }
      if (line.startsWith("/attach ")) {
        await showRun(line.slice(8).trim());
        continue;
      }
      if (line.startsWith("/")) {
        process.stdout.write("Unknown command.\n");
        continue;
      }
      const run = await createRun(line);
      process.stdout.write(`Created ${run.id}. Use /attach ${run.id} to inspect it.\n`);
    }
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command && process.stdin.isTTY) {
    await interactiveSession();
    return;
  }
  const selectedCommand = command ?? "devices";
  if (selectedCommand === "daemon") {
    const operation = process.argv[3] ?? "status";
    if (operation === "serve") {
      await serveDaemon();
      return;
    }
    if (operation === "start") {
      const state = await startDaemonProcess();
      process.stdout.write(`TapRig daemon running at ${state.url} (PID ${state.pid}).\n`);
      return;
    }
    if (operation === "stop") {
      process.stdout.write(
        (await stopDaemonProcess())
          ? "TapRig daemon stopped.\n"
          : "TapRig daemon is not running.\n",
      );
      return;
    }
    if (operation === "status") {
      const state = await daemonStatus();
      process.stdout.write(
        state
          ? `TapRig daemon running at ${state.url} (PID ${state.pid}).\n`
          : "TapRig daemon is not running.\n",
      );
      return;
    }
    throw new Error(`unknown daemon command: ${operation}`);
  }
  if (selectedCommand === "model") {
    const operation = process.argv[3] ?? "show";
    const config = loadOrCreateModelConfig();
    if (operation === "show") {
      const profile = config.profiles[config.selectedProfile];
      process.stdout.write(`Profile: ${config.selectedProfile}\n`);
      for (const role of ["fast", "strong", "vision"] as const) {
        const selected = profile.roles[role];
        process.stdout.write(`${role}: ${selected.provider}/${selected.model}\n`);
      }
      for (const [name, provider] of Object.entries(config.providers)) {
        process.stdout.write(
          `${name}: ${process.env[provider.apiKeyEnv] ? "configured" : `missing ${provider.apiKeyEnv}`}\n`,
        );
      }
      return;
    }
    if (operation === "profile") {
      const profile = process.argv[4] as ModelProfileName | undefined;
      if (!profile || !(["economy", "balanced", "best"] as const).includes(profile)) {
        throw new Error("model profile must be economy, balanced, or best");
      }
      config.selectedProfile = profile;
      saveModelConfig(config);
      process.stdout.write(`Model profile set to ${profile}.\n`);
      return;
    }
    if (operation === "set") {
      const profile = process.argv[4] as ModelProfileName | undefined;
      const role = process.argv[5] as ModelRole | undefined;
      const model = process.argv[6];
      const provider = process.argv[7] ?? "openai";
      if (!profile || !(["economy", "balanced", "best"] as const).includes(profile)) {
        throw new Error("model set requires an economy, balanced, or best profile");
      }
      if (!role || !(["fast", "strong", "vision"] as const).includes(role) || !model) {
        throw new Error("model set requires a fast, strong, or vision role and model ID");
      }
      if (!config.providers[provider]) throw new Error(`unknown model provider: ${provider}`);
      config.profiles[profile].roles[role] = { provider, model };
      saveModelConfig(config);
      process.stdout.write(`${profile}/${role} set to ${provider}/${model}.\n`);
      return;
    }
    throw new Error(`unknown model command: ${operation}`);
  }
  if (selectedCommand === "script") {
    const operation = process.argv[3] ?? "list";
    if (operation === "list") {
      const { scripts } = await daemonJson<{ scripts: TapRigScript[] }>("/scripts");
      if (scripts.length === 0) process.stdout.write("No scripts yet.\n");
      for (const script of scripts) {
        process.stdout.write(`${script.id}\tv${script.version}\t${script.name}\n`);
      }
      return;
    }
    if (operation === "inspect") {
      const id = process.argv[4];
      if (!id) throw new Error("script inspect requires a script ID");
      const result = await daemonJson<{ script: TapRigScript }>(
        `/scripts/${encodeURIComponent(id)}`,
      );
      process.stdout.write(`${JSON.stringify(result.script, null, 2)}\n`);
      return;
    }
    if (operation === "create") {
      const path = process.argv[4];
      if (!path) throw new Error("script create requires a JSON file path");
      const result = await daemonJson<{ script: TapRigScript }>("/scripts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: readFileSync(path, "utf8"),
      });
      process.stdout.write(`Saved ${result.script.id} v${result.script.version}.\n`);
      return;
    }
    if (operation === "run") {
      const id = process.argv[4];
      const deviceId = process.argv[5];
      if (!id || !deviceId) throw new Error("script run requires a script ID and device ID");
      const inputs = Object.fromEntries(
        process.argv.slice(6).map((argument) => {
          const separator = argument.indexOf("=");
          if (separator < 1) throw new Error("script inputs must use name=value");
          return [argument.slice(0, separator), argument.slice(separator + 1)];
        }),
      );
      const response = await daemonJson<{ result: ScriptRunResult; recoveryRun?: RunState }>(
        `/scripts/${encodeURIComponent(id)}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId, inputs }),
        },
      );
      process.stdout.write(`${JSON.stringify(response)}\n`);
      if (response.result.status === "recovery-needed" && !response.recoveryRun)
        process.exitCode = 2;
      return;
    }
    if (operation === "promote") {
      const runId = process.argv[4];
      const id = process.argv[5];
      const name = process.argv.slice(6).join(" ").trim();
      if (!runId || !id || !name) {
        throw new Error("script promote requires a run ID, script ID, and name");
      }
      const { script } = await daemonJson<{ script: TapRigScript }>(
        `/runs/${encodeURIComponent(runId)}/promote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, name }),
        },
      );
      process.stdout.write(`Promoted ${runId} to ${script.id} v${script.version}.\n`);
      return;
    }
    throw new Error(`unknown script command: ${operation}`);
  }
  if (selectedCommand === "ui") {
    const { url } = await daemonJson<{ url: string }>("/browser-sessions", { method: "POST" });
    process.stdout.write(`${url}\n`);
    return;
  }
  if (selectedCommand === "execute") {
    const execution = parseExecuteCommand(process.argv.slice(3));
    const response = await daemonRequest(
      `/devices/${encodeURIComponent(execution.serial)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: execution.action }),
      },
    );
    if (!response.ok) throw new Error(`daemon rejected action with HTTP ${response.status}`);
    process.stdout.write(`Action sent to ${execution.serial}; result not yet verified.\n`);
    return;
  }
  if (selectedCommand === "run") {
    const run = await createRun(process.argv.slice(3).join(" "));
    process.stdout.write(`${run.id}\t${run.status}\n`);
    return;
  }
  if (selectedCommand === "runs") {
    printRuns(await listRuns());
    return;
  }
  if (selectedCommand === "attach") {
    const id = process.argv[3];
    if (!id) throw new Error("attach requires a run ID");
    await showRun(id);
    return;
  }

  const devices = await loadDevices();
  if (selectedCommand === "devices") {
    process.stdout.write(`${formatAdbDevices(devices)}\n`);
    return;
  }
  if (selectedCommand === "doctor") {
    const findings = diagnoseAdbDevices(devices);
    process.stdout.write(`${formatDoctorFindings(findings)}\n`);
    if (findings.some(({ status }) => status === "fail")) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command: ${selectedCommand}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`TapRig: ${message}\n`);
  process.exitCode = 1;
});
