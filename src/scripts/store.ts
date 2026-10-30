import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parseRawAction } from "../android/raw-actions.ts";
import type { Action, Selector } from "../core/contracts.ts";
import { dataDirectory } from "../paths.ts";
import type { TapRigScript } from "./contracts.ts";

const identifier = /^[a-z][a-z0-9_-]{0,63}$/u;

function parseSelector(value: unknown): Selector {
  if (!value || typeof value !== "object") throw new Error("invalid script selector");
  const selector = value as Record<string, unknown>;
  if (typeof selector.elementId === "string") return { elementId: selector.elementId };
  if (typeof selector.resourceId === "string") return { resourceId: selector.resourceId };
  if (typeof selector.description === "string") return { description: selector.description };
  if (typeof selector.text === "string") {
    return {
      text: selector.text,
      ...(typeof selector.role === "string" ? { role: selector.role } : {}),
    };
  }
  throw new Error("invalid script selector");
}

function parseAction(value: unknown): Action {
  try {
    return parseRawAction(value);
  } catch {
    if (!value || typeof value !== "object") throw new Error("invalid script action");
    const action = value as Record<string, unknown>;
    if (action.type === "element.tap" || action.type === "element.longTap") {
      return { type: action.type, target: parseSelector(action.target) };
    }
    if (action.type === "element.text" && typeof action.value === "string") {
      return {
        type: "element.text",
        target: parseSelector(action.target),
        value: action.value,
        ...(typeof action.clear === "boolean" ? { clear: action.clear } : {}),
      };
    }
    throw new Error("invalid script action");
  }
}

export function validateScript(script: TapRigScript): TapRigScript {
  if (script.schemaVersion !== 1) throw new Error("unsupported script schema version");
  if (!identifier.test(script.id) || !script.name.trim())
    throw new Error("invalid script identity");
  if (script.origin !== "user" && script.origin !== "bundled" && script.origin !== "learned") {
    throw new Error("invalid script origin");
  }
  if (!Number.isSafeInteger(script.version) || script.version < 1) {
    throw new Error("script version must be a positive integer");
  }
  if (script.parameters.length > 50 || script.steps.length === 0 || script.steps.length > 200) {
    throw new Error("script must contain 1-200 steps and at most 50 parameters");
  }
  const names = new Set<string>();
  for (const parameter of script.parameters) {
    if (
      !identifier.test(parameter.name) ||
      names.has(parameter.name) ||
      typeof parameter.required !== "boolean" ||
      (parameter.default !== undefined && typeof parameter.default !== "string")
    ) {
      throw new Error("script parameter names must be unique identifiers");
    }
    names.add(parameter.name);
  }
  const stepIds = new Set<string>();
  for (const step of script.steps) {
    if (!identifier.test(step.id) || stepIds.has(step.id)) {
      throw new Error("script step IDs must be unique identifiers");
    }
    step.action = parseAction(step.action);
    if (step.checkpoint?.selector)
      step.checkpoint.selector = parseSelector(step.checkpoint.selector);
    if (
      step.checkpoint?.foregroundPackage !== undefined &&
      typeof step.checkpoint.foregroundPackage !== "string"
    ) {
      throw new Error("invalid script checkpoint package");
    }
    stepIds.add(step.id);
  }
  return script;
}

export class ScriptStore {
  readonly directory: string;

  constructor(directory = join(dataDirectory(), "scripts")) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  save(script: TapRigScript): void {
    validateScript(script);
    const path = join(this.directory, `${script.id}.v${script.version}.json`);
    if (existsSync(path)) throw new Error(`script ${script.id} v${script.version} already exists`);
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(script, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  }

  get(id: string): TapRigScript | undefined {
    if (!identifier.test(id)) throw new Error("invalid script ID");
    const expression = new RegExp(`^${id}\\.v(\\d+)\\.json$`, "u");
    const version = readdirSync(this.directory)
      .map((name) => Number(expression.exec(name)?.[1] ?? 0))
      .filter((candidate) => Number.isSafeInteger(candidate) && candidate > 0)
      .sort((left, right) => right - left)[0];
    if (!version) return undefined;
    return validateScript(
      JSON.parse(readFileSync(join(this.directory, `${id}.v${version}.json`), "utf8")),
    );
  }

  list(): TapRigScript[] {
    return [...new Set(readdirSync(this.directory).map((name) => name.split(".v")[0]))]
      .filter((id): id is string => id !== undefined && identifier.test(id))
      .map((id) => this.get(id))
      .filter((script): script is TapRigScript => script !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}
