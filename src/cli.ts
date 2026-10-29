#!/usr/bin/env node

import { type AdbDevice, formatAdbDevices } from "./android/adb-discovery.ts";
import {
  daemonRequest,
  daemonStatus,
  serveDaemon,
  startDaemonProcess,
  stopDaemonProcess,
} from "./daemon/lifecycle.ts";
import { diagnoseAdbDevices, formatDoctorFindings } from "./doctor.ts";
import { parseExecuteCommand } from "./execute-command.ts";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "devices";
  if (command === "daemon") {
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
  if (command === "execute") {
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

  const response = await daemonRequest("/devices");
  if (!response.ok) throw new Error(`daemon returned HTTP ${response.status}`);
  const inventory = (await response.json()) as {
    devices: Array<{
      serial: string;
      transportState: AdbDevice["transportState"];
      identity?: { model?: string };
    }>;
  };
  const devices: AdbDevice[] = inventory.devices.map((device) => ({
    serial: device.serial,
    transportState: device.transportState,
    ...(device.identity?.model ? { model: device.identity.model } : {}),
  }));
  if (command === "devices") {
    process.stdout.write(`${formatAdbDevices(devices)}\n`);
    return;
  }
  if (command === "doctor") {
    const findings = diagnoseAdbDevices(devices);
    process.stdout.write(`${formatDoctorFindings(findings)}\n`);
    if (findings.some(({ status }) => status === "fail")) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`TapRig: ${message}\n`);
  process.exitCode = 1;
});
