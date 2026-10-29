import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataDirectory } from "../paths.ts";

export function daemonTokenPath(): string {
  return join(dataDirectory(), "daemon.token");
}

export function getOrCreateDaemonToken(path = daemonTokenPath()): string {
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    const token = readFileSync(path, "utf8").trim();
    if (!/^[a-f0-9]{64}$/u.test(token)) throw new Error("invalid daemon token file");
    return token;
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return token;
}
