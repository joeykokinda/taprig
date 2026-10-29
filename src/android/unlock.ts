import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CredentialBroker, SecretRef } from "../security/credential-broker.ts";
import { parseKeyguardUnlocked } from "./device-actor.ts";

const execFileAsync = promisify(execFile);

export type UnlockAdb = (serial: string, args: readonly string[]) => Promise<string>;

export async function runUnlockAdb(serial: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("adb", ["-s", serial, "shell", ...args]);
  return stdout;
}

function screenSize(output: string): { width: number; height: number } {
  const match = /Physical size: (\d+)x(\d+)/u.exec(output);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("could not determine device screen size");
  }
  return { width, height };
}

export interface UnlockOptions {
  serial: string;
  credential: SecretRef;
  broker: CredentialBroker;
  adb?: UnlockAdb;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function unlockWithPin(
  options: UnlockOptions,
): Promise<"already-unlocked" | "unlocked"> {
  const adb = options.adb ?? runUnlockAdb;
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const keyguard = async () => adb(options.serial, ["dumpsys", "window", "policy"]);

  if (parseKeyguardUnlocked(await keyguard())) return "already-unlocked";

  const pin = options.broker.access(options.credential, {
    deviceId: options.serial,
    purpose: "device.unlock",
  });
  if (!/^\d{4,16}$/u.test(pin)) throw new Error("configured unlock secret is not a 4-16 digit PIN");

  const { width, height } = screenSize(await adb(options.serial, ["wm", "size"]));
  await adb(options.serial, ["input", "keyevent", "KEYCODE_WAKEUP"]);
  await adb(options.serial, [
    "input",
    "swipe",
    String(Math.floor(width / 2)),
    String(Math.floor(height * 0.8)),
    String(Math.floor(width / 2)),
    String(Math.floor(height * 0.2)),
    "300",
  ]);
  await adb(options.serial, ["input", "text", pin]);
  await adb(options.serial, ["input", "keyevent", "KEYCODE_ENTER"]);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await wait(200);
    if (parseKeyguardUnlocked(await keyguard())) return "unlocked";
  }
  throw new Error("unlock verification failed");
}
