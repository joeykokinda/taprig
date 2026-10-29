import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { parseRawAction } from "../android/raw-actions.ts";
import type { Action } from "../core/contracts.ts";

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
      if (request.method === "GET" && request.url === "/health") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method === "GET" && request.url === "/devices") {
        response.end(JSON.stringify({ devices: await options.devices.list() }));
        return;
      }
      const actionRoute = /^\/devices\/([^/]+)\/actions$/u.exec(request.url ?? "");
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
