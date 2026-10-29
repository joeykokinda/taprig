import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { captureScreenshot } from "../src/android/screenshot.ts";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("test-image"),
]);

test("captures a bounded PNG without overwriting an artifact", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-screenshot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "screen.png");
  const artifact = await captureScreenshot(
    "phone-1",
    outputPath,
    async () => png,
    () => "2026-10-29T01:00:00.000Z",
  );

  assert.deepEqual(artifact, {
    path: outputPath,
    bytes: png.length,
    capturedAt: "2026-10-29T01:00:00.000Z",
  });
  assert.deepEqual(await readFile(outputPath), png);
  await assert.rejects(
    captureScreenshot("phone-1", outputPath, async () => png),
    /EEXIST/,
  );
});

test("rejects invalid screenshot data before writing", async () => {
  await assert.rejects(
    captureScreenshot("phone-1", "/tmp/not-written.png", async () => Buffer.from("not png")),
    /valid PNG/,
  );
});
