import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { parseRawAction } from "../android/raw-actions.ts";
import { TakeoverLeases } from "../control/takeover.ts";
import type { Action, RunMode } from "../core/contracts.ts";
import type { RunService } from "../runs/service.ts";
import type { ScriptService } from "../scripts/service.ts";
import type { LiveMjpegStream } from "../video/live-stream.ts";

export interface DaemonDevice {
  id: string;
  serial: string;
  state: string;
}

export interface DeviceInventory {
  list(): Promise<readonly DaemonDevice[]>;
}

export interface TapRigDaemonOptions {
  token: string;
  devices: DeviceInventory;
  host?: string;
  port?: number;
  execute?: (serial: string, action: Action) => Promise<void>;
  runs?: RunService;
  startRun?: (runId: string) => void;
  scripts?: ScriptService;
  stream?: (serial: string) => Promise<LiveMjpegStream>;
  manualTap?: (serial: string, xRatio: number, yRatio: number) => Promise<void>;
}

async function jsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface RunningDaemon {
  url: string;
  stop(): Promise<void>;
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isAuthorized(
  header: string | undefined,
  cookie: string | undefined,
  token: string,
  browserSessions: ReadonlyMap<string, number>,
): boolean {
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
  const browserToken = cookie
    ?.split(";")
    .map((value) => value.trim().split("="))
    .find(([name]) => name === "taprig_session")?.[1];
  return Boolean(browserToken && (browserSessions.get(browserToken) ?? 0) > Date.now());
}

export async function startDaemon(options: TapRigDaemonOptions): Promise<RunningDaemon> {
  if (!options.token) throw new Error("daemon token must not be empty");
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("daemon must bind to loopback");
  }
  const pendingBrowserSessions = new Map<string, number>();
  const browserSessions = new Map<string, number>();
  const takeover = new TakeoverLeases();
  const controlRoom = join(import.meta.dirname, "../../control-room");

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const now = Date.now();
    for (const [key, expiry] of pendingBrowserSessions)
      if (expiry <= now) pendingBrowserSessions.delete(key);
    for (const [key, expiry] of browserSessions) if (expiry <= now) browserSessions.delete(key);
    const browserSessionRoute = /^\/session\/([a-f0-9]{64})$/u.exec(url.pathname);
    if (request.method === "GET" && browserSessionRoute?.[1]) {
      const nonce = browserSessionRoute[1];
      if ((pendingBrowserSessions.get(nonce) ?? 0) <= now) {
        response.statusCode = 401;
        response.end("Expired browser session");
        return;
      }
      pendingBrowserSessions.delete(nonce);
      const session = randomBytes(32).toString("hex");
      browserSessions.set(session, now + 24 * 60 * 60 * 1000);
      response.statusCode = 302;
      response.setHeader(
        "set-cookie",
        `taprig_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      );
      response.setHeader("location", "/");
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (
      !isAuthorized(
        request.headers.authorization,
        request.headers.cookie,
        options.token,
        browserSessions,
      )
    ) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/browser-sessions") {
        const nonce = randomBytes(32).toString("hex");
        pendingBrowserSessions.set(nonce, Date.now() + 60_000);
        response.statusCode = 201;
        response.end(
          JSON.stringify({ url: `http://${request.headers.host ?? "127.0.0.1"}/session/${nonce}` }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/devices") {
        response.end(JSON.stringify({ devices: await options.devices.list() }));
        return;
      }
      const streamRoute = /^\/devices\/([^/]+)\/stream\.mjpeg$/u.exec(url.pathname);
      if (request.method === "GET" && streamRoute?.[1]) {
        if (!options.stream) throw new Error("live streaming is unavailable");
        const live = await options.stream(decodeURIComponent(streamRoute[1]));
        response.setHeader("content-type", "multipart/x-mixed-replace; boundary=ffmpeg");
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        live.stream.once("error", () => response.destroy());
        response.once("close", () => void live.stop());
        live.stream.pipe(response);
        return;
      }
      const takeoverRoute = /^\/devices\/([^/]+)\/takeover$/u.exec(url.pathname);
      if (takeoverRoute?.[1]) {
        const deviceId = decodeURIComponent(takeoverRoute[1]);
        try {
          if (request.method === "POST") {
            response.statusCode = 201;
            response.end(JSON.stringify({ lease: takeover.acquire(deviceId) }));
            return;
          }
          const body = (await jsonBody(request)) as { leaseId?: unknown };
          if (typeof body.leaseId !== "string") throw new Error("lease ID is required");
          if (request.method === "PATCH") {
            response.end(JSON.stringify({ lease: takeover.renew(deviceId, body.leaseId) }));
            return;
          }
          if (request.method === "DELETE") {
            takeover.release(deviceId, body.leaseId);
            response.statusCode = 204;
            response.end();
            return;
          }
        } catch {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "takeover-unavailable" }));
          return;
        }
      }
      const manualRoute = /^\/devices\/([^/]+)\/manual-actions$/u.exec(url.pathname);
      if (request.method === "POST" && manualRoute?.[1]) {
        const serial = decodeURIComponent(manualRoute[1]);
        try {
          const body = (await jsonBody(request)) as Record<string, unknown>;
          if (typeof body.leaseId !== "string") throw new Error("lease ID is required");
          takeover.require(serial, body.leaseId);
          if (
            body.type === "tap" &&
            typeof body.xRatio === "number" &&
            typeof body.yRatio === "number"
          ) {
            if (!options.manualTap) throw new Error("manual taps are unavailable");
            await options.manualTap(serial, body.xRatio, body.yRatio);
          } else if (body.type === "key" && typeof body.key === "string") {
            if (!options.execute) throw new Error("manual keys are unavailable");
            await options.execute(serial, parseRawAction({ type: "key.press", key: body.key }));
          } else {
            throw new Error("invalid manual action");
          }
          response.end(JSON.stringify({ lease: takeover.renew(serial, body.leaseId) }));
        } catch {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "manual-action-rejected" }));
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/runs") {
        response.end(JSON.stringify({ runs: options.runs?.list() ?? [] }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/scripts") {
        response.end(JSON.stringify({ scripts: options.scripts?.list() ?? [] }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/scripts") {
        if (!options.scripts) throw new Error("script service is unavailable");
        try {
          const script = options.scripts.create(await jsonBody(request));
          response.statusCode = 201;
          response.end(JSON.stringify({ script }));
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-script" }));
        }
        return;
      }
      const scriptRunRoute = /^\/scripts\/([^/]+)\/run$/u.exec(url.pathname);
      if (request.method === "POST" && scriptRunRoute?.[1]) {
        if (!options.scripts) throw new Error("script service is unavailable");
        try {
          const body = (await jsonBody(request)) as { deviceId?: unknown; inputs?: unknown };
          if (
            typeof body.deviceId !== "string" ||
            !body.inputs ||
            typeof body.inputs !== "object"
          ) {
            throw new Error("invalid script run");
          }
          const result = await options.scripts.run(
            decodeURIComponent(scriptRunRoute[1]),
            body.deviceId,
            body.inputs as Record<string, string>,
          );
          response.end(JSON.stringify({ result }));
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-script-run" }));
        }
        return;
      }
      const scriptRoute = /^\/scripts\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && scriptRoute?.[1]) {
        const script = options.scripts?.get(decodeURIComponent(scriptRoute[1]));
        if (!script) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "script-not-found" }));
          return;
        }
        response.end(JSON.stringify({ script }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/runs") {
        if (!options.runs) throw new Error("run service is unavailable");
        try {
          const body = (await jsonBody(request)) as { task?: unknown; mode?: unknown };
          if (typeof body.task !== "string") throw new Error("task must be a string");
          const run = options.runs.create(
            body.task,
            body.mode === undefined ? undefined : (body.mode as RunMode),
          );
          response.statusCode = 201;
          response.end(JSON.stringify({ run }));
          options.startRun?.(run.id);
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-run" }));
        }
        return;
      }
      const eventRoute = /^\/runs\/([^/]+)\/events$/u.exec(url.pathname);
      if (request.method === "GET" && eventRoute?.[1]) {
        const runId = decodeURIComponent(eventRoute[1]);
        if (!options.runs?.get(runId)) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "run-not-found" }));
          return;
        }
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(after) || after < 0) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-event-sequence" }));
          return;
        }
        response.end(JSON.stringify({ events: options.runs.events(runId, after) }));
        return;
      }
      const runRoute = /^\/runs\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && runRoute?.[1]) {
        const run = options.runs?.get(decodeURIComponent(runRoute[1]));
        if (!run) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "run-not-found" }));
          return;
        }
        response.end(JSON.stringify({ run }));
        return;
      }
      const actionRoute = /^\/devices\/([^/]+)\/actions$/u.exec(url.pathname);
      if (request.method === "POST" && actionRoute?.[1]) {
        if (!options.execute) throw new Error("action execution is unavailable");
        const serial = decodeURIComponent(actionRoute[1]);
        let action: Action;
        try {
          const body = (await jsonBody(request)) as { action?: unknown };
          action = parseRawAction(body.action);
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-action" }));
          return;
        }
        await options.execute(serial, action);
        response.statusCode = 202;
        response.end(JSON.stringify({ accepted: true, verified: false }));
        return;
      }
      const asset =
        url.pathname === "/"
          ? { file: "index.html", type: "text/html; charset=utf-8" }
          : url.pathname === "/control-room.css"
            ? { file: "control-room.css", type: "text/css; charset=utf-8" }
            : url.pathname === "/control-room.js"
              ? { file: "control-room.js", type: "text/javascript; charset=utf-8" }
              : undefined;
      if (request.method === "GET" && asset) {
        response.setHeader("content-type", asset.type);
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-frame-options", "DENY");
        response.setHeader(
          "content-security-policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        );
        response.end(readFileSync(join(controlRoom, asset.file)));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not-found" }));
    } catch {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "internal-error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await stopServer(server);
    throw new Error("daemon did not receive a TCP address");
  }

  return {
    url: `http://${host === "::1" ? `[${host}]` : host}:${address.port}`,
    stop: () => stopServer(server),
  };
}
