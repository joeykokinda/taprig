import type { Action, Element } from "../../core/contracts.ts";

export const DRIVER_PROTOCOL_VERSION = 1 as const;
export const DRIVER_MAX_MESSAGE_BYTES = 1024 * 1024;

export type DriverRequest =
  | { id: string; type: "hello"; version: typeof DRIVER_PROTOCOL_VERSION; nonce: string }
  | { id: string; type: "snapshot" }
  | { id: string; type: "wait"; afterGeneration: string; timeoutMs: number }
  | { id: string; type: "perform"; expectedGeneration: string; action: Action }
  | { id: string; type: "health" }
  | { id: string; type: "stop" };

export interface DriverSnapshot {
  generation: string;
  capturedAt: string;
  foregroundPackage?: string;
  elements: readonly Element[];
}

export interface DriverError {
  code: string;
  message: string;
}

export class DriverCallError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`driver ${code}: ${message}`);
    this.code = code;
  }
}

export type DriverResponse =
  | { id: string; ok: true; result: unknown }
  | { id: string; ok: false; error: DriverError };

export type DriverResult<T extends DriverRequest["type"]> = T extends "hello"
  ? { version: typeof DRIVER_PROTOCOL_VERSION; nonce: string }
  : T extends "snapshot"
    ? DriverSnapshot
    : T extends "wait"
      ? { changed: boolean; snapshot: DriverSnapshot | null }
      : T extends "perform"
        ? { generation: string; evidence: string }
        : T extends "health"
          ? { version: typeof DRIVER_PROTOCOL_VERSION; generation: string }
          : { stopped: true };

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${name} contains unexpected field ${unexpected}`);
}

function text(value: unknown, name: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string up to ${maximum} characters`);
  }
  return value;
}

function parseElement(value: unknown): Element {
  const item = record(value, "element");
  exact(
    item,
    ["id", "role", "text", "description", "resourceId", "actionable", "bounds", "password"],
    "element",
  );
  if (typeof item.actionable !== "boolean") throw new Error("element.actionable must be boolean");
  if (item.password !== undefined && item.password !== true)
    throw new Error("element.password must be true when present");
  const optionalText = (name: "text" | "description" | "resourceId") => {
    const candidate = item[name];
    return candidate === undefined ? undefined : text(candidate, `element.${name}`);
  };
  let bounds: Element["bounds"];
  if (item.bounds !== undefined) {
    const parsed = record(item.bounds, "element.bounds");
    exact(parsed, ["left", "top", "right", "bottom"], "element.bounds");
    for (const key of ["left", "top", "right", "bottom"] as const) {
      if (!Number.isSafeInteger(parsed[key]))
        throw new Error(`element.bounds.${key} must be integer`);
    }
    bounds = parsed as unknown as NonNullable<Element["bounds"]>;
  }
  const itemText = optionalText("text");
  const description = optionalText("description");
  const resourceId = optionalText("resourceId");
  return {
    id: text(item.id, "element.id", 512),
    role: text(item.role, "element.role", 128),
    ...(itemText ? { text: itemText } : {}),
    ...(description ? { description } : {}),
    ...(resourceId ? { resourceId } : {}),
    actionable: item.actionable,
    ...(bounds ? { bounds } : {}),
    ...(item.password ? { password: true } : {}),
  };
}

function parseSnapshot(value: unknown): DriverSnapshot {
  const snapshot = record(value, "snapshot");
  exact(snapshot, ["generation", "capturedAt", "foregroundPackage", "elements"], "snapshot");
  if (!Array.isArray(snapshot.elements) || snapshot.elements.length > 10_000) {
    throw new Error("snapshot.elements must be an array of at most 10000 elements");
  }
  return {
    generation: text(snapshot.generation, "snapshot.generation", 256),
    capturedAt: text(snapshot.capturedAt, "snapshot.capturedAt", 64),
    ...(snapshot.foregroundPackage === undefined
      ? {}
      : { foregroundPackage: text(snapshot.foregroundPackage, "snapshot.foregroundPackage", 256) }),
    elements: snapshot.elements.map(parseElement),
  };
}

export function encodeDriverRequest(request: DriverRequest): Buffer {
  const encoded = Buffer.from(`${JSON.stringify(request)}\n`);
  if (encoded.byteLength - 1 > DRIVER_MAX_MESSAGE_BYTES) {
    throw new Error(`driver request exceeds ${DRIVER_MAX_MESSAGE_BYTES} bytes`);
  }
  return encoded;
}

export function parseDriverResponse(value: unknown): DriverResponse {
  const response = record(value, "driver response");
  if (typeof response.ok !== "boolean") throw new Error("driver response.ok must be boolean");
  if (response.ok) {
    exact(response, ["id", "ok", "result"], "driver response");
    if (!("result" in response)) throw new Error("successful driver response requires result");
    return { id: text(response.id, "driver response.id", 256), ok: true, result: response.result };
  }
  exact(response, ["id", "ok", "error"], "driver response");
  const error = record(response.error, "driver response.error");
  exact(error, ["code", "message"], "driver response.error");
  return {
    id: text(response.id, "driver response.id", 256),
    ok: false,
    error: {
      code: text(error.code, "driver response.error.code", 128),
      message: text(error.message, "driver response.error.message"),
    },
  };
}

export function parseDriverResult<R extends DriverRequest>(
  typedRequest: R,
  response: DriverResponse,
): DriverResult<R["type"]> {
  type T = R["type"];
  const request: DriverRequest = typedRequest;
  if (response.id !== request.id) throw new Error(`unexpected driver response ${response.id}`);
  if (!response.ok) throw new DriverCallError(response.error.code, response.error.message);
  const result = record(response.result, `${request.type} result`);
  if (request.type === "hello") {
    exact(result, ["version", "nonce"], "hello result");
    if (result.version !== DRIVER_PROTOCOL_VERSION)
      throw new Error("driver protocol version mismatch");
    if (result.nonce !== request.nonce) throw new Error("driver session nonce mismatch");
    return { version: DRIVER_PROTOCOL_VERSION, nonce: request.nonce } as DriverResult<T>;
  }
  if (request.type === "snapshot") return parseSnapshot(result) as DriverResult<T>;
  if (request.type === "wait") {
    exact(result, ["changed", "snapshot"], "wait result");
    if (typeof result.changed !== "boolean") throw new Error("wait result.changed must be boolean");
    if (result.changed !== (result.snapshot !== null)) {
      throw new Error("wait result snapshot must match changed state");
    }
    return {
      changed: result.changed,
      snapshot: result.snapshot === null ? null : parseSnapshot(result.snapshot),
    } as DriverResult<T>;
  }
  if (request.type === "perform") {
    exact(result, ["generation", "evidence"], "perform result");
    return {
      generation: text(result.generation, "perform result.generation", 256),
      evidence: text(result.evidence, "perform result.evidence"),
    } as DriverResult<T>;
  }
  if (request.type === "health") {
    exact(result, ["version", "generation"], "health result");
    if (result.version !== DRIVER_PROTOCOL_VERSION)
      throw new Error("driver protocol version mismatch");
    return {
      version: DRIVER_PROTOCOL_VERSION,
      generation: text(result.generation, "health result.generation", 256),
    } as DriverResult<T>;
  }
  exact(result, ["stopped"], "stop result");
  if (result.stopped !== true) throw new Error("stop result.stopped must be true");
  return { stopped: true } as DriverResult<T>;
}

export class DriverFrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): DriverResponse[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const responses: DriverResponse[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.byteLength > DRIVER_MAX_MESSAGE_BYTES) {
          throw new Error(`driver message exceeds ${DRIVER_MAX_MESSAGE_BYTES} bytes`);
        }
        return responses;
      }
      if (newline > DRIVER_MAX_MESSAGE_BYTES) {
        throw new Error(`driver message exceeds ${DRIVER_MAX_MESSAGE_BYTES} bytes`);
      }
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.byteLength === 0) throw new Error("driver message cannot be empty");
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      } catch {
        throw new Error("driver message is not valid UTF-8 JSON");
      }
      responses.push(parseDriverResponse(value));
    }
  }
}
