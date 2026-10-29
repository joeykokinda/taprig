import { createHash } from "node:crypto";

import type { Element, Observation, Selector } from "../core/contracts.ts";
import { type AdbCommandRunner, runAdbShell } from "./raw-actions.ts";

const maximumNodes = 5000;

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(source: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of source.matchAll(/([\w-]+)="([^"]*)"/gu)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], decodeXml(match[2]));
    }
  }
  return values;
}

function bounds(value: string | undefined): Element["bounds"] {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(value ?? "");
  if (!match) return undefined;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  if (
    left === undefined ||
    top === undefined ||
    right === undefined ||
    bottom === undefined ||
    right <= left ||
    bottom <= top
  ) {
    return undefined;
  }
  return { left, top, right, bottom };
}

export function parseUiHierarchy(
  deviceId: string,
  output: string,
  capturedAt = new Date().toISOString(),
): Observation {
  const xmlStart = output.indexOf("<?xml");
  if (xmlStart < 0) throw new Error("UIAutomator returned no XML hierarchy");
  const xml = output.slice(xmlStart);
  const nodes = [...xml.matchAll(/<node\b([^>]*)\/?\s*>/gu)];
  if (nodes.length > maximumNodes) throw new Error(`UI hierarchy exceeds ${maximumNodes} nodes`);

  const elements: Element[] = [];
  const packages = new Map<string, number>();
  for (const [index, match] of nodes.entries()) {
    const values = attributes(match[1] ?? "");
    const className = values.get("class") ?? "android.view.View";
    const packageName = values.get("package");
    if (packageName) packages.set(packageName, (packages.get(packageName) ?? 0) + 1);
    const elementBounds = bounds(values.get("bounds"));
    const text = values.get("text");
    const description = values.get("content-desc");
    const resourceId = values.get("resource-id");

    elements.push({
      id: `node-${index}`,
      role: className.split(".").at(-1) ?? className,
      ...(text ? { text } : {}),
      ...(description ? { description } : {}),
      ...(resourceId ? { resourceId } : {}),
      actionable:
        values.get("clickable") === "true" ||
        values.get("long-clickable") === "true" ||
        values.get("scrollable") === "true",
      ...(elementBounds ? { bounds: elementBounds } : {}),
    });
  }

  const foregroundPackage = [...packages].sort((left, right) => right[1] - left[1])[0]?.[0];
  return {
    deviceId,
    generation: createHash("sha256").update(xml).digest("hex"),
    ...(foregroundPackage ? { foregroundPackage } : {}),
    elements,
    capturedAt,
  };
}

export type SemanticDumpRunner = (serial: string) => Promise<string>;

export async function dumpUiHierarchy(serial: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile("adb", ["-s", serial, "shell", "uiautomator", "dump", "/dev/tty"], (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });
}

export async function observeSemantics(
  deviceId: string,
  dump: SemanticDumpRunner = dumpUiHierarchy,
  now = () => new Date().toISOString(),
): Promise<Observation> {
  return parseUiHierarchy(deviceId, await dump(deviceId), now());
}

export function resolveElement(observation: Observation, selector: Selector): Element {
  const matches = observation.elements.filter((element) => {
    if ("elementId" in selector) return element.id === selector.elementId;
    if ("resourceId" in selector) return element.resourceId === selector.resourceId;
    if ("description" in selector) return element.description === selector.description;
    return element.text === selector.text && (!selector.role || element.role === selector.role);
  });
  if (matches.length === 0) throw new Error("semantic target not found");
  if (matches.length > 1) throw new Error("semantic selector is ambiguous");
  const element = matches[0];
  if (!element) throw new Error("semantic target not found");
  return element;
}

export async function tapSemanticElement(
  serial: string,
  observation: Observation,
  selector: Selector,
  run: AdbCommandRunner = runAdbShell,
): Promise<void> {
  const element = resolveElement(observation, selector);
  if (!element.actionable || !element.bounds) throw new Error("semantic target is not tappable");
  const x = Math.floor((element.bounds.left + element.bounds.right) / 2);
  const y = Math.floor((element.bounds.top + element.bounds.bottom) / 2);
  await run(serial, ["input", "tap", String(x), String(y)]);
}
