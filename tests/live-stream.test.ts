import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  liveStreamArguments,
  screenshotFallbackArguments,
  startLiveMjpegStream,
} from "../src/video/live-stream.ts";

test("builds bounded scrcpy-to-mjpeg streaming arguments", () => {
  const args = liveStreamArguments(
    { serial: "phone-1", scrcpyExecutable: "scrcpy", framesPerSecond: 5, width: 360 },
    "/tmp/video.mkv",
  );
  assert.deepEqual(args.scrcpy.slice(0, 6), [
    "--serial",
    "phone-1",
    "--no-playback",
    "--no-control",
    "--no-audio",
    "--no-window",
  ]);
  assert.ok(args.scrcpy.includes("--record-format=mkv"));
  assert.ok(args.scrcpy.includes("--video-codec-options=repeat-previous-frame-after:long=100000"));
  assert.ok(args.ffmpeg.includes("fps=5,scale=360:-2"));
  assert.throws(
    () =>
      liveStreamArguments(
        { serial: "phone-1", scrcpyExecutable: "scrcpy", framesPerSecond: 60 },
        "/tmp/video.mkv",
      ),
    /1 to 15/,
  );
});

test("falls back to screenshots when scrcpy produces no live frames", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-live-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const idle = join(directory, "idle");
  const adb = join(directory, "adb");
  const ffmpeg = join(directory, "ffmpeg");
  await writeFile(idle, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
  await writeFile(adb, "#!/bin/sh\nprintf 'screenshot\\n'\n", { mode: 0o700 });
  await writeFile(
    ffmpeg,
    '#!/bin/sh\ncase "$*" in *image2pipe*) read frame; printf -- "--ffmpeg\\r\\nContent-Type: image/jpeg\\r\\n\\r\\nfallback";; *) exec sleep 30;; esac\n',
    { mode: 0o700 },
  );
  const live = await startLiveMjpegStream({
    serial: "phone-1",
    scrcpyExecutable: idle,
    adbExecutable: adb,
    ffmpegExecutable: ffmpeg,
  });
  context.after(() => live.stop());
  const frame = await new Promise<Buffer>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("fallback produced no frame")), 4_000);
    live.stream.once("data", resolve);
    live.stream.once("error", reject);
    live.stream.once("data", () => clearTimeout(timeout));
  });
  assert.match(frame.toString(), /fallback/);
});

test("builds a bounded screenshot fallback pipeline", () => {
  const args = screenshotFallbackArguments({
    serial: "phone-1",
    scrcpyExecutable: "scrcpy",
    framesPerSecond: 5,
    width: 360,
  });
  assert.deepEqual(args.adb, ["-s", "phone-1", "exec-out", "screencap", "-p"]);
  assert.ok(args.ffmpeg.includes("scale=360:-2"));
});
