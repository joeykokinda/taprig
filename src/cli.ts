#!/usr/bin/env node

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
