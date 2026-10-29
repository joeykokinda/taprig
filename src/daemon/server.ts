import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { parseRawAction } from "../android/raw-actions.ts";
import type { Action, RunMode } from "../core/contracts.ts";
import type { RunService } from "../runs/service.ts";

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

function isAuthorized(header: string | undefined, token: string): boolean {
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startDaemon(options: TapRigDaemonOptions): Promise<RunningDaemon> {
  if (!options.token) throw new Error("daemon token must not be empty");
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("daemon must bind to loopback");
  }

  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (!isAuthorized(request.headers.authorization, options.token)) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/devices") {
        response.end(JSON.stringify({ devices: await options.devices.list() }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/runs") {
        response.end(JSON.stringify({ runs: options.runs?.list() ?? [] }));
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
