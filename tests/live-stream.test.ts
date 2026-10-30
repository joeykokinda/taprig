import assert from "node:assert/strict";
import test from "node:test";

import { liveStreamArguments } from "../src/video/live-stream.ts";

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
