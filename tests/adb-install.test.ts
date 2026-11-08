import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureAdbOnPath, managedAdbPath } from "../src/android/adb-install.ts";

test("uses adb from PATH, then TapRig's own platform-tools, and downloads only when both are missing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "taprig-adb-"));
  const onPath = join(directory, "bin");
  mkdirSync(onPath);
  writeFileSync(join(onPath, "adb"), "#!/bin/sh\n");
  chmodSync(join(onPath, "adb"), 0o755);
  const environment = { PATH: onPath };
  assert.equal(await ensureAdbOnPath(environment, "linux", directory), join(onPath, "adb"));

  const requested: string[] = [];
  const download = async (url: string) => {
    requested.push(url);
    throw new Error("offline");
  };
  const empty = { PATH: "" };
  await assert.rejects(ensureAdbOnPath(empty, "linux", directory, download), /offline/u);
  assert.deepEqual(requested, [
    "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
  ]);

  const managed = managedAdbPath("linux", directory);
  mkdirSync(join(directory, "platform-tools"));
  writeFileSync(managed, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(await ensureAdbOnPath(empty, "linux", directory, download), managed);
  assert.equal(requested.length, 1);
  assert.ok(empty.PATH.startsWith(join(directory, "platform-tools")));
  await assert.rejects(
    ensureAdbOnPath({ PATH: "" }, "freebsd", mkdtempSync(join(tmpdir(), "taprig-bsd-")), download),
    /freebsd/u,
  );
});
