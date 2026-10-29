import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Action } from "../core/contracts.ts";

const execFileAsync = promisify(execFile);

export type AdbCommandRunner = (serial: string, args: readonly string[]) => Promise<void>;

export async function runAdbShell(serial: string, args: readonly string[]): Promise<void> {
  await execFileAsync("adb", ["-s", serial, "shell", ...args]);
}

const keyCodes = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  recents: "KEYCODE_APP_SWITCH",
  enter: "KEYCODE_ENTER",
  delete: "KEYCODE_DEL",
} as const;

function coordinate(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("coordinates must be non-negative integers");
  return String(value);
}

function packageName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(value)) {
    throw new Error("invalid Android package name");
  }
  return value;
}

export async function executeRawAction(
  serial: string,
  action: Action,
  run: AdbCommandRunner = runAdbShell,
): Promise<void> {
  if (!serial) throw new Error("device serial must not be empty");

  switch (action.type) {
    case "app.launch":
      await run(serial, [
        "monkey",
        "-p",
        packageName(action.packageName),
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ]);
      return;
    case "key.press":
      await run(serial, ["input", "keyevent", keyCodes[action.key]]);
      return;
    case "gesture.tap":
      await run(serial, ["input", "tap", coordinate(action.x), coordinate(action.y)]);
      return;
    case "gesture.swipe":
      if (
        !Number.isSafeInteger(action.durationMs) ||
        action.durationMs < 1 ||
        action.durationMs > 60_000
      ) {
        throw new Error("swipe duration must be an integer from 1 to 60000 milliseconds");
      }
      await run(serial, [
        "input",
        "swipe",
        coordinate(action.from.x),
        coordinate(action.from.y),
        coordinate(action.to.x),
        coordinate(action.to.y),
        String(action.durationMs),
      ]);
      return;
    default:
      throw new Error(`${action.type} requires the TapRig semantic driver`);
  }
}
