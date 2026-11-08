import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect as connectSocket } from "node:net";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

import type {
  ActionBatch,
  BatchResult,
  DeviceAdapter,
  DeviceId,
  ErrorCode,
  Observation,
  StepResult,
} from "../../core/contracts.ts";
import {
  DRIVER_PROTOCOL_VERSION,
  DriverCallError,
  DriverFrameDecoder,
  type DriverRequest,
  type DriverResult,
  encodeDriverRequest,
  parseDriverResult,
} from "./protocol.ts";

const execFileAsync = promisify(execFile);

export const androidDriver = {
  targetPackage: "dev.taprig.driver.stub",
  driverPackage: "dev.taprig.driver",
  runner: "dev.taprig.driver/dev.taprig.driver.TapRigInstrumentation",
  nonceArgument: "nonce",
  socket: "taprig-driver",
  protocolVersion: DRIVER_PROTOCOL_VERSION,
} as const;

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type DriverCall = DistributiveOmit<Exclude<DriverRequest, { type: "hello" }>, "id">;

export interface DriverRpc {
  readonly alive: boolean;
  call<T extends DriverCall>(request: T): Promise<DriverResult<T["type"]>>;
  close(): void;
}

export interface DriverProcess {
  stop(): void;
}

export interface DriverHost {
  adb(args: readonly string[]): Promise<string>;
  startAdb(args: readonly string[]): DriverProcess;
  connect(port: number, nonce: string): Promise<DriverRpc>;
}

export interface DriverArtifacts {
  targetApk: string;
  targetSha256: string;
  testApk: string;
  testSha256: string;
}

export interface AndroidDriverSessionOptions extends DriverArtifacts {
  serial: string;
  host: DriverHost;
  nonce?: string;
}

const tapRigErrorCodes = new Set<string>([
  "stale-observation",
  "ambiguous-selector",
  "target-not-found",
  "unsupported-action",
  "verification-failed",
]);

function stepError(error: unknown): NonNullable<StepResult["error"]> {
  const code: ErrorCode =
    error instanceof DriverCallError
      ? tapRigErrorCodes.has(error.code)
        ? (error.code as ErrorCode)
        : "verification-failed"
      : "transport-failed";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: code === "verification-failed" || code === "stale-observation",
  };
}

async function verifyArtifact(path: string, expected: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("driver APK path must be absolute");
  if (!/^[a-f0-9]{64}$/u.test(expected)) {
    throw new Error("driver APK checksum must be lowercase SHA-256");
  }
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (actual !== expected) throw new Error(`driver APK checksum mismatch: ${path}`);
}

function parseForwardPort(output: string): number {
  const port = Number(output.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("adb returned an invalid driver port");
  }
  return port;
}

function validateSerial(serial: string): void {
  if (!serial.trim() || serial.length > 200 || /[\r\n\0]/u.test(serial)) {
    throw new Error("invalid Android device serial");
  }
}

// Reinstalling an unchanged sideloaded APK on every enrollment trips Play Protect prompts that block
// later installs, so only install when the device copy differs from the verified bundle.
async function installIfChanged(
  host: DriverHost,
  serial: string,
  packageName: string,
  apk: string,
  sha256: string,
): Promise<void> {
  const device = ["-s", serial];
  const installed = await host
    .adb([...device, "shell", "pm", "path", packageName])
    .then((output) => /^package:(\S+)$/mu.exec(output)?.[1])
    .catch(() => undefined);
  if (installed) {
    const digest = await host.adb([...device, "shell", "sha256sum", installed]).catch(() => "");
    if (digest.split(/\s/u)[0] === sha256) return;
  }
  try {
    await host.adb([...device, "install", "-t", "-r", apk]);
  } catch (error) {
    // Builds from another machine carry another signing key; the driver packages hold no user data.
    if (!String(error).includes("INSTALL_FAILED_UPDATE_INCOMPATIBLE")) throw error;
    await host.adb([...device, "uninstall", packageName]);
    await host.adb([...device, "install", "-t", "-r", apk]);
  }
}

function cleanup(host: DriverHost, serial: string, port: number): Promise<unknown> {
  const device = ["-s", serial];
  return Promise.allSettled([
    host.adb([...device, "forward", "--remove", `tcp:${port}`]),
    host.adb([...device, "shell", "am", "force-stop", androidDriver.targetPackage]),
  ]);
}

export class AndroidDriverSession implements DeviceAdapter {
  readonly serial: string;
  readonly #host: DriverHost;
  readonly #port: number;
  readonly #process: DriverProcess;
  readonly #rpc: DriverRpc;
  readonly #results = new Map<string, BatchResult>();
  #closed = false;

  private constructor(
    serial: string,
    host: DriverHost,
    port: number,
    process: DriverProcess,
    rpc: DriverRpc,
  ) {
    this.serial = serial;
    this.#host = host;
    this.#port = port;
    this.#process = process;
    this.#rpc = rpc;
  }

  static async enroll(options: AndroidDriverSessionOptions): Promise<AndroidDriverSession> {
    validateSerial(options.serial);
    await Promise.all([
      verifyArtifact(options.targetApk, options.targetSha256),
      verifyArtifact(options.testApk, options.testSha256),
    ]);

    const device = ["-s", options.serial];
    await installIfChanged(
      options.host,
      options.serial,
      androidDriver.targetPackage,
      options.targetApk,
      options.targetSha256,
    );
    await installIfChanged(
      options.host,
      options.serial,
      androidDriver.driverPackage,
      options.testApk,
      options.testSha256,
    );
    // A crashed or killed daemon can leave its forward behind; clear this phone's old ones.
    const forwards = await options.host.adb(["forward", "--list"]).catch(() => "");
    for (const line of forwards.split("\n")) {
      const [serial, local, remote] = line.trim().split(/\s+/u);
      if (
        serial === options.serial &&
        remote === `localabstract:${androidDriver.socket}` &&
        local
      ) {
        await options.host.adb([...device, "forward", "--remove", local]).catch(() => undefined);
      }
    }
    const port = parseForwardPort(
      await options.host.adb([
        ...device,
        "forward",
        "tcp:0",
        `localabstract:${androidDriver.socket}`,
      ]),
    );
    const nonce = options.nonce ?? randomBytes(32).toString("hex");
    const process = options.host.startAdb([
      ...device,
      "shell",
      "am",
      "instrument",
      "-w",
      "-r",
      "-e",
      androidDriver.nonceArgument,
      nonce,
      androidDriver.runner,
    ]);

    try {
      const rpc = await options.host.connect(port, nonce);
      return new AndroidDriverSession(options.serial, options.host, port, process, rpc);
    } catch (error) {
      process.stop();
      await cleanup(options.host, options.serial, port);
      throw error;
    }
  }

  get alive(): boolean {
    return !this.#closed && this.#rpc.alive;
  }

  #call<T extends DriverCall>(request: T): Promise<DriverResult<T["type"]>> {
    if (this.#closed) return Promise.reject(new Error("Android driver session is closed"));
    return this.#rpc.call(request);
  }

  async observe(deviceId: DeviceId = this.serial): Promise<Observation> {
    if (deviceId !== this.serial) throw new Error("observation requested for another device");
    const snapshot = await this.#call({ type: "snapshot" });
    return { deviceId: this.serial, ...snapshot };
  }

  async waitForChange(afterGeneration: string, timeoutMs: number): Promise<Observation | null> {
    const result = await this.#call({ type: "wait", afterGeneration, timeoutMs });
    return result.snapshot && { deviceId: this.serial, ...result.snapshot };
  }

  async execute(batch: ActionBatch): Promise<BatchResult> {
    if (batch.deviceId !== this.serial) throw new Error("action batch targets another device");
    const previous = this.#results.get(batch.requestId);
    if (previous) return { ...previous, replayed: true };

    let generation = batch.observationGeneration;
    let failed = false;
    const steps: StepResult[] = [];
    for (const step of batch.steps) {
      if (failed) {
        steps.push({ stepId: step.id, status: "skipped", durationMs: 0 });
        continue;
      }
      const startedAt = performance.now();
      try {
        const result = await this.#call({
          type: "perform",
          expectedGeneration: generation,
          action: step.action,
        });
        generation = result.generation;
        steps.push({
          stepId: step.id,
          status: "verified",
          durationMs: performance.now() - startedAt,
        });
      } catch (error) {
        failed = true;
        steps.push({
          stepId: step.id,
          status: "failed",
          durationMs: performance.now() - startedAt,
          error: stepError(error),
        });
      }
    }
    const result: BatchResult = {
      requestId: batch.requestId,
      deviceId: this.serial,
      steps,
      replayed: false,
    };
    this.#results.set(batch.requestId, result);
    return result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#rpc.alive) await this.#rpc.call({ type: "stop" }).catch(() => undefined);
    this.#closed = true;
    this.#rpc.close();
    this.#process.stop();
    await cleanup(this.#host, this.serial, this.#port);
  }
}

export interface AndroidDriverManagerOptions extends DriverArtifacts {
  host: DriverHost;
  retryAfterMs?: number;
  now?: () => number;
  onEnrollmentError?: (serial: string, error: unknown) => void;
}

export class AndroidDriverManager {
  #options: AndroidDriverManagerOptions;
  readonly #sessions = new Map<string, AndroidDriverSession>();
  readonly #enrolling = new Set<string>();
  readonly #retryAt = new Map<string, number>();

  constructor(options: AndroidDriverManagerOptions) {
    this.#options = options;
  }

  get(serial: string): AndroidDriverSession | undefined {
    const session = this.#sessions.get(serial);
    return session?.alive ? session : undefined;
  }

  /** Swaps in a rebuilt bundle; phones re-enroll on the next sync. */
  async reload(bundle: DriverBundle): Promise<void> {
    this.#options = { ...this.#options, ...bundle };
    this.#retryAt.clear();
    await this.close();
  }

  async sync(serials: readonly string[]): Promise<void> {
    const wanted = new Set(serials);
    const now = this.#options.now ?? Date.now;
    const closing: Promise<void>[] = [];
    for (const [serial, session] of this.#sessions) {
      if (wanted.has(serial) && session.alive) continue;
      this.#sessions.delete(serial);
      closing.push(session.close());
    }
    for (const serial of this.#retryAt.keys()) {
      if (!wanted.has(serial)) this.#retryAt.delete(serial);
    }
    const enrolling = [...wanted]
      .filter(
        (serial) =>
          !this.#sessions.has(serial) &&
          !this.#enrolling.has(serial) &&
          (this.#retryAt.get(serial) ?? 0) <= now(),
      )
      .map(async (serial) => {
        this.#enrolling.add(serial);
        try {
          const session = await AndroidDriverSession.enroll({ ...this.#options, serial });
          this.#sessions.set(serial, session);
          this.#retryAt.delete(serial);
        } catch (error) {
          this.#retryAt.set(serial, now() + (this.#options.retryAfterMs ?? 60_000));
          this.#options.onEnrollmentError?.(serial, error);
        } finally {
          this.#enrolling.delete(serial);
        }
      });
    await Promise.allSettled([...closing, ...enrolling]);
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
  }
}

export interface DriverConnectOptions {
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export function connectDriver(
  port: number,
  nonce: string,
  options: DriverConnectOptions = {},
): Promise<DriverRpc> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const socket = connectSocket({ host: "127.0.0.1", port });
    const decoder = new DriverFrameDecoder();
    const pending = new Map<
      string,
      {
        request: DriverRequest;
        resolve: (value: never) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    let alive = false;
    let sequence = 0;

    const fail = (error: Error) => {
      alive = false;
      socket.destroy();
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      pending.clear();
      reject(error);
    };

    const send = <T extends DriverRequest>(request: T): Promise<DriverResult<T["type"]>> =>
      new Promise((resolveCall, rejectCall) => {
        if (socket.destroyed) {
          rejectCall(new Error("Android driver connection is closed"));
          return;
        }
        const waitMs = request.type === "wait" ? request.timeoutMs : 0;
        const timer = setTimeout(() => {
          pending.delete(request.id);
          rejectCall(new Error(`Android driver ${request.type} timed out`));
          fail(new Error("Android driver stopped responding"));
        }, requestTimeoutMs + waitMs);
        pending.set(request.id, {
          request,
          resolve: resolveCall as (value: never) => void,
          reject: rejectCall,
          timer,
        });
        socket.write(encodeDriverRequest(request));
      });

    const rpc: DriverRpc = {
      get alive() {
        return alive;
      },
      call: (request) => send({ ...request, id: `r${++sequence}` } as DriverRequest),
      close: () => {
        fail(new Error("Android driver connection is closed"));
      },
    } as DriverRpc;

    socket.setNoDelay(true);
    socket.setTimeout(options.connectTimeoutMs ?? 5_000, () =>
      fail(new Error("Android driver connection timed out")),
    );
    socket.on("data", (chunk) => {
      try {
        for (const response of decoder.push(chunk as Buffer)) {
          const entry = pending.get(response.id);
          if (!entry) throw new Error(`unexpected driver response ${response.id}`);
          pending.delete(response.id);
          clearTimeout(entry.timer);
          try {
            entry.resolve(parseDriverResult(entry.request, response) as never);
          } catch (error) {
            entry.reject(error as Error);
          }
        }
      } catch (error) {
        fail(error as Error);
      }
    });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("Android driver disconnected")));
    socket.on("connect", () => {
      socket.setTimeout(0);
      alive = true;
      send({ id: "hello", type: "hello", version: DRIVER_PROTOCOL_VERSION, nonce }).then(
        () => resolve(rpc),
        fail,
      );
    });
  });
}

export function createAdbDriverHost(adbPath = "adb", startupTimeoutMs = 20_000): DriverHost {
  return {
    adb: async (args) => (await execFileAsync(adbPath, [...args], { timeout: 120_000 })).stdout,
    startAdb: (args) => {
      const child = spawn(adbPath, [...args], { stdio: "ignore" });
      return { stop: () => child.kill("SIGTERM") };
    },
    // adb accepts forwarded connections before the device socket exists, so retry hello until the
    // instrumentation is listening.
    connect: async (port, nonce) => {
      const deadline = Date.now() + startupTimeoutMs;
      for (;;) {
        try {
          return await connectDriver(port, nonce);
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
  };
}

export interface DriverBundle extends DriverArtifacts {
  protocolVersion: number;
}

export async function loadDriverBundle(directory: string): Promise<DriverBundle> {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (manifest.protocolVersion !== DRIVER_PROTOCOL_VERSION) {
    throw new Error("Android driver bundle protocol version mismatch");
  }
  for (const key of ["stub", "driver"] as const) {
    const entry = manifest[key];
    if (typeof entry?.file !== "string" || entry.file.includes("/") || entry.file.includes("\\")) {
      throw new Error(`Android driver bundle ${key} file is invalid`);
    }
  }
  return {
    protocolVersion: manifest.protocolVersion,
    targetApk: join(directory, manifest.stub.file),
    targetSha256: manifest.stub.sha256,
    testApk: join(directory, manifest.driver.file),
    testSha256: manifest.driver.sha256,
  };
}
