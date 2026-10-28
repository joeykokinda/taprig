#!/usr/bin/env node

import { discoverAdbDevices, formatAdbDevices } from "./android/adb-discovery.ts";

async function main(): Promise<void> {
  const command = process.argv[2] ?? "devices";
  if (command !== "devices") throw new Error(`unknown command: ${command}`);

  const devices = await discoverAdbDevices();
  process.stdout.write(`${formatAdbDevices(devices)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`TapRig: ${message}\n`);
  process.exitCode = 1;
});
