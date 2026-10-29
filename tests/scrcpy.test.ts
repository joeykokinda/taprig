import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { recordScrcpyVideo, scrcpyRelease } from "../src/video/scrcpy.ts";

test("records with pinned safe headless arguments and private permissions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-scrcpy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "screen.mkv");
  let received: readonly string[] = [];

  const artifact = await recordScrcpyVideo(
    {
      executable: "/opt/taprig/scrcpy",
      serial: "phone-1",
      outputPath,
      durationSeconds: 3,
      run: async (_executable, args) => {
        received = args;
        await writeFile(outputPath, "video");
      },
    },
    () => "2026-10-29T02:00:00.000Z",
  );

  assert.deepEqual(received, [
    "--serial",
    "phone-1",
    "--no-playback",
    "--no-control",
    "--no-audio",
    "--no-window",
    `--record=${outputPath}`,
    "--time-limit=3",
  ]);
  assert.equal(artifact.bytes, 5);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.equal(scrcpyRelease.version, "5.0.1");
});

test("refuses overwrite and unbounded recording requests", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-scrcpy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "screen.mkv");
  await writeFile(outputPath, "existing");

  await assert.rejects(
    recordScrcpyVideo({
      executable: "scrcpy",
      serial: "phone-1",
      outputPath,
      durationSeconds: 3,
      run: async () => {},
    }),
    /already exists/,
  );
  await assert.rejects(
    recordScrcpyVideo({
      executable: "scrcpy",
      serial: "phone-1",
      outputPath: join(directory, "too-long.mkv"),
      durationSeconds: 301,
      run: async () => {},
    }),
    /1 to 300 seconds/,
  );
});
