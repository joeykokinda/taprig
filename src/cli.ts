#!/usr/bin/env node

import { discoverAdbDevices, formatAdbDevices } from "./android/adb-discovery.ts";
import { executeRawAction } from "./android/raw-actions.ts";
import { diagnoseAdbDevices, formatDoctorFindings } from "./doctor.ts";
import { parseExecuteCommand } from "./execute-command.ts";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "devices";
  if (command === "execute") {
    const execution = parseExecuteCommand(process.argv.slice(3));
    await executeRawAction(execution.serial, execution.action);
    process.stdout.write(`Action sent to ${execution.serial}; result not yet verified.\n`);
    return;
  }

  const devices = await discoverAdbDevices();
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
