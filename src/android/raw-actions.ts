import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Action, Selector } from "../core/contracts.ts";

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

function parseSelector(value: unknown): Selector {
  const selector = value as Record<string, unknown> | undefined;
  const text = (key: string) => {
    const candidate = selector?.[key];
    return typeof candidate === "string" && candidate.length > 0 && candidate.length <= 2_000
      ? candidate
      : undefined;
  };
  const elementId = text("elementId");
  if (elementId) return { elementId };
  const resourceId = text("resourceId");
  if (resourceId) return { resourceId };
  const description = text("description");
  if (description) return { description };
  const label = text("text");
  const role = text("role");
  if (label) return { text: label, ...(role ? { role } : {}) };
  throw new Error("selector needs elementId, resourceId, description, or text");
}

/** Raw actions plus semantic element actions, validated at the daemon boundary. */
export function parseAction(value: unknown): Action {
  const action = value as Record<string, unknown> | undefined;
  if (action?.type === "element.tap" || action?.type === "element.longTap") {
    return { type: action.type, target: parseSelector(action.target) };
  }
  if (action?.type === "element.text") {
    if (typeof action.value !== "string" || action.value.length > 10_000) {
      throw new Error("text value must be a string up to 10000 characters");
    }
    return {
      type: "element.text",
      target: parseSelector(action.target),
      value: action.value,
      ...(typeof action.clear === "boolean" ? { clear: action.clear } : {}),
    };
  }
  return parseRawAction(value);
}

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

const launcherIntent = [
  "-a",
  "android.intent.action.MAIN",
  "-c",
  "android.intent.category.LAUNCHER",
];

/** The launcher activity for a package, when the phone can resolve one. */
export async function resolveLauncherActivity(
  serial: string,
  name: string,
  output: AdbOutputRunner = runAdbOutput,
): Promise<string | undefined> {
  const listing = await output(serial, [
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    ...launcherIntent,
    packageName(name),
  ]).catch(() => "");
  const component = listing.trim().split(/\r?\n/u).at(-1)?.trim();
  return component && /^[\w.]+\/[\w.$]+$/u.test(component) ? component : undefined;
}

export async function executeRawAction(
  serial: string,
  action: Action,
  run: AdbCommandRunner = runAdbShell,
  output: AdbOutputRunner = runAdbOutput,
): Promise<void> {
  if (!serial) throw new Error("device serial must not be empty");

  switch (action.type) {
    case "app.launch": {
      // Resolve the activity first: `am start -p` cannot start apps whose main activity lives in
      // another package (X), and monkey's one random event can re-enable auto-rotate.
      const component = await resolveLauncherActivity(serial, action.packageName, output);
      await run(
        serial,
        component
          ? ["am", "start", "-n", component]
          : ["am", "start", ...launcherIntent, "-p", packageName(action.packageName)],
      );
      return;
    }
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

/** Third-party packages on the phone, so the model can launch any installed app by name. */
export async function listThirdPartyPackages(
  serial: string,
  output: AdbOutputRunner = runAdbOutput,
): Promise<string[]> {
  const listing = await output(serial, ["pm", "list", "packages", "-3"]);
  return listing
    .split(/\r?\n/u)
    .map((line) => line.replace(/^package:/u, "").trim())
    .filter((name) => name.length > 0)
    .sort();
}

/**
 * Types into whatever field has focus, for a human driving the phone from the control room.
 * ponytail: `input text` is ASCII only; the driver's element.text covers unicode for the agent.
 */
export async function executeManualText(
  serial: string,
  text: string,
  run: AdbCommandRunner = runAdbShell,
): Promise<void> {
  if (!serial) throw new Error("device serial must not be empty");
  if (text.length === 0 || text.length > 10_000 || /[^\x20-\x7e]/u.test(text)) {
    throw new Error("manual text must be 1 to 10000 printable ASCII characters");
  }
  // adb shell re-parses its arguments remotely, so quote for the phone's shell.
  const quoted = `'${text.replaceAll(" ", "%s").replaceAll("'", "'\\''")}'`;
  await run(serial, ["input", "text", quoted]);
}
