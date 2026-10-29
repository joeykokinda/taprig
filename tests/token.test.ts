import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getOrCreateDaemonToken } from "../src/daemon/token.ts";
import { dataDirectory } from "../src/paths.ts";

test("persists one private daemon token", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-token-"));
  const path = join(directory, "daemon.token");
  context.after(() => rm(directory, { recursive: true }));

  const first = getOrCreateDaemonToken(path);
  const second = getOrCreateDaemonToken(path);

  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(second, first);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await readFile(path, "utf8")).trim(), first);
});

test("requires an absolute data-directory override", () => {
  assert.throws(
    () => dataDirectory("linux", { TAPRIG_DATA_DIR: "relative" }, "/home/test"),
    /absolute/,
  );
  assert.equal(
    dataDirectory("linux", { TAPRIG_DATA_DIR: "/tmp/taprig-data" }, "/home/test"),
    "/tmp/taprig-data",
  );
});
