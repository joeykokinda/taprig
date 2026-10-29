import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

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

    if (request.method !== "GET") {
      response.statusCode = 405;
      response.end(JSON.stringify({ error: "method-not-allowed" }));
      return;
    }

    try {
      if (request.url === "/health") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.url === "/devices") {
        response.end(JSON.stringify({ devices: await options.devices.list() }));
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
