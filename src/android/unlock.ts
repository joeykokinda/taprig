import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CredentialBroker, SecretRef } from "../security/credential-broker.ts";
import { parseForegroundActivity, parseKeyguardUnlocked } from "./device-actor.ts";

const execFileAsync = promisify(execFile);

export type UnlockAdb = (serial: string, args: readonly string[]) => Promise<string>;

export async function runUnlockAdb(serial: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.env.TAPRIG_ADB ?? "adb", [
    "-s",
    serial,
    "shell",
    ...args,
  ]);
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

/** Wakes the screen and swipes past a swipe-only keyguard; a PIN keyguard stays locked. */
export async function wakeAndSwipe(serial: string, adb: UnlockAdb = runUnlockAdb): Promise<void> {
  const { width, height } = screenSize(await adb(serial, ["wm", "size"]));
  await adb(serial, ["input", "keyevent", "KEYCODE_WAKEUP"]);
  await adb(serial, [
    "input",
    "swipe",
    String(Math.floor(width / 2)),
    String(Math.floor(height * 0.8)),
    String(Math.floor(width / 2)),
    String(Math.floor(height * 0.2)),
    "300",
  ]);
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

  // MENU asks the keyguard for its PIN pad directly. A swipe is not: lock-screen overlays such as
  // Moto's Glance swallow it, and on Android 14 it opened the shade instead of the bouncer.
  await adb(options.serial, ["input", "keyevent", "KEYCODE_WAKEUP"]);
  // An overlay that occludes the keyguard (Glance relaunches on every wake) also eats MENU, so
  // stop whatever is on top first. The keyguard itself is never a resumed activity.
  if (/^\s*occluded=true\s*$/mu.test(await keyguard())) {
    const top = parseForegroundActivity(
      await adb(options.serial, ["dumpsys", "activity", "activities"]),
    );
    if (top) {
      await adb(options.serial, ["am", "force-stop", top.packageName]);
      await wait(500);
    }
  }
  await adb(options.serial, ["input", "keyevent", "KEYCODE_MENU"]);
  await wait(800);
  await adb(options.serial, ["input", "text", pin]);
  await adb(options.serial, ["input", "keyevent", "KEYCODE_ENTER"]);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await wait(200);
    if (parseKeyguardUnlocked(await keyguard())) return "unlocked";
  }
  throw new Error("unlock verification failed");
}

/**
 * Rig phones lie on desks, where auto-rotate flips apps sideways and portrait gestures land
 * off screen. Every run therefore pins the phone to portrait before it starts.
 */
export async function lockPortrait(serial: string, adb: UnlockAdb = runUnlockAdb): Promise<void> {
  await adb(serial, ["settings", "put", "system", "accelerometer_rotation", "0"]);
  await adb(serial, ["settings", "put", "system", "user_rotation", "0"]);
}
