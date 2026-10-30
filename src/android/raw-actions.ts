import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Action } from "../core/contracts.ts";

const execFileAsync = promisify(execFile);

export type AdbCommandRunner = (serial: string, args: readonly string[]) => Promise<void>;
export type AdbOutputRunner = (serial: string, args: readonly string[]) => Promise<string>;

export async function runAdbShell(serial: string, args: readonly string[]): Promise<void> {
  await execFileAsync("adb", ["-s", serial, "shell", ...args]);
}

export async function runAdbOutput(serial: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("adb", ["-s", serial, "shell", ...args]);
  return stdout;
}

const keyCodes = {
  back: "KEYCODE_BACK",
  home: "KEYCODE_HOME",
  recents: "KEYCODE_APP_SWITCH",
  enter: "KEYCODE_ENTER",
  delete: "KEYCODE_DEL",
} as const;

export function parseRawAction(value: unknown): Action {
  if (!value || typeof value !== "object") throw new Error("action must be an object");
  const action = value as Record<string, unknown>;
  if (action.type === "app.launch" && typeof action.packageName === "string") {
    return { type: "app.launch", packageName: action.packageName };
  }
  if (action.type === "key.press" && typeof action.key === "string" && action.key in keyCodes) {
    return { type: "key.press", key: action.key as keyof typeof keyCodes };
  }
  if (
    action.type === "gesture.tap" &&
    typeof action.x === "number" &&
    typeof action.y === "number"
  ) {
    return { type: "gesture.tap", x: action.x, y: action.y };
  }
  const from = action.from as Record<string, unknown> | undefined;
  const to = action.to as Record<string, unknown> | undefined;
  if (
    action.type === "gesture.swipe" &&
    typeof from?.x === "number" &&
    typeof from.y === "number" &&
    typeof to?.x === "number" &&
    typeof to.y === "number" &&
    typeof action.durationMs === "number"
  ) {
    return {
      type: "gesture.swipe",
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      durationMs: action.durationMs,
    };
  }
  throw new Error("unsupported or malformed raw action");
}

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

export async function executeNormalizedTap(
  serial: string,
  xRatio: number,
  yRatio: number,
  output: AdbOutputRunner = runAdbOutput,
  run: AdbCommandRunner = runAdbShell,
): Promise<void> {
  if (
    !Number.isFinite(xRatio) ||
    !Number.isFinite(yRatio) ||
    xRatio < 0 ||
    xRatio > 1 ||
    yRatio < 0 ||
    yRatio > 1
  ) {
    throw new Error("normalized tap coordinates must be from 0 to 1");
  }
  const sizes = [
    ...(await output(serial, ["wm", "size"])).matchAll(
      /(?:Physical|Override) size:\s*(\d+)x(\d+)/gu,
    ),
  ];
  const size = sizes.at(-1);
  const width = Number(size?.[1]);
  const height = Number(size?.[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Android display size is unavailable");
  }
  await run(serial, [
    "input",
    "tap",
    String(Math.min(width - 1, Math.floor(xRatio * width))),
    String(Math.min(height - 1, Math.floor(yRatio * height))),
  ]);
}
