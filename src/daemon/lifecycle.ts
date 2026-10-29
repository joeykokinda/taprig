import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { dataDirectory } from "../paths.ts";
import { startRuntime } from "./runtime.ts";
import { getOrCreateDaemonToken } from "./token.ts";

interface DaemonState {
  pid: number;
  url: string;
  startedAt: string;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const statePath = () => join(dataDirectory(), "daemon.json");

function readState(): DaemonState | undefined {
  try {
    const state = JSON.parse(readFileSync(statePath(), "utf8")) as DaemonState;
    if (!Number.isSafeInteger(state.pid) || state.pid < 1 || !state.url.startsWith("http://")) {
      throw new Error("invalid daemon state file");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function removeState(): void {
  try {
    unlinkSync(statePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeState(state: DaemonState): void {
  const path = statePath();
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

async function isHealthy(state: DaemonState, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${state.url}/health`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function daemonStatus(): Promise<DaemonState | undefined> {
  const state = readState();
  if (!state) return undefined;
  return (await isHealthy(state, getOrCreateDaemonToken())) ? state : undefined;
}

export async function daemonRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const state = (await daemonStatus()) ?? (await startDaemonProcess());
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${getOrCreateDaemonToken()}`);
  return fetch(`${state.url}${path}`, { ...init, headers });
}

export async function startDaemonProcess(scriptPath = process.argv[1]): Promise<DaemonState> {
  if (!scriptPath) throw new Error("cannot locate the TapRig CLI entrypoint");
  const running = await daemonStatus();
  if (running) return running;
  removeState();
  const token = getOrCreateDaemonToken();

  const log = openSync(join(dataDirectory(), "daemon.log"), "a", 0o600);
  chmodSync(join(dataDirectory(), "daemon.log"), 0o600);
  const child = spawn(process.execPath, [scriptPath, "daemon", "serve"], {
    detached: true,
    env: process.env,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    const state = readState();
    if (state && (await isHealthy(state, token))) return state;
  }
  throw new Error("daemon did not become ready; inspect daemon.log");
}

export async function stopDaemonProcess(): Promise<boolean> {
  const state = readState();
  if (!state) return false;
  const token = getOrCreateDaemonToken();
  if (!(await isHealthy(state, token))) {
    removeState();
    return false;
  }
  process.kill(state.pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await wait(100);
    if (!readState()) return true;
  }
  throw new Error("daemon did not stop within five seconds");
}

export async function serveDaemon(): Promise<void> {
  const token = getOrCreateDaemonToken();
  const existing = readState();
  if (existing && (await isHealthy(existing, token))) throw new Error("daemon is already running");
  removeState();
  const runtime = await startRuntime({ token });
  try {
    writeState({ pid: process.pid, url: runtime.url, startedAt: new Date().toISOString() });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } finally {
    try {
      await runtime.stop();
    } finally {
      removeState();
    }
  }
}
