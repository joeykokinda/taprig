import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LiveMjpegStream {
  stream: Readable;
  stop(): Promise<void>;
}

export interface LiveStreamOptions {
  serial: string;
  scrcpyExecutable: string;
  ffmpegExecutable?: string;
  framesPerSecond?: number;
  width?: number;
}

export function liveStreamArguments(options: LiveStreamOptions, fifo: string) {
  const framesPerSecond = options.framesPerSecond ?? 5;
  const width = options.width ?? 360;
  if (!options.serial) throw new Error("stream device serial must not be empty");
  if (!Number.isSafeInteger(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 15) {
    throw new Error("stream frame rate must be an integer from 1 to 15");
  }
  if (!Number.isSafeInteger(width) || width < 160 || width > 1080) {
    throw new Error("stream width must be an integer from 160 to 1080");
  }
  return {
    scrcpy: [
      "--serial",
      options.serial,
      "--no-playback",
      "--no-control",
      "--no-audio",
      "--no-window",
      "--max-fps=15",
      "--video-codec-options=repeat-previous-frame-after:long=100000",
      `--record=${fifo}`,
      "--record-format=mkv",
    ],
    ffmpeg: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      fifo,
      "-vf",
      `fps=${framesPerSecond},scale=${width}:-2`,
      "-q:v",
      "5",
      "-f",
      "mpjpeg",
      "pipe:1",
    ],
  };
}

function closed(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    process.once("close", () => resolve());
    process.once("error", () => resolve());
  });
}

export async function startLiveMjpegStream(options: LiveStreamOptions): Promise<LiveMjpegStream> {
  // shortcut: FIFO transport is Unix-only; replace it with native pipes before Windows packaging.
  if (process.platform === "win32")
    throw new Error("live scrcpy streaming is not yet available on Windows");
  const directory = await mkdtemp(join(tmpdir(), "taprig-stream-"));
  const fifo = join(directory, "video.mkv");
  await execFileAsync("mkfifo", [fifo]);
  const args = liveStreamArguments(options, fifo);
  const ffmpeg = spawn(options.ffmpegExecutable ?? "ffmpeg", args.ffmpeg, {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const scrcpy = spawn(options.scrcpyExecutable, args.scrcpy, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    if (scrcpy.exitCode === null) scrcpy.kill("SIGTERM");
    if (ffmpeg.exitCode === null) ffmpeg.kill("SIGTERM");
    stopping = Promise.all([closed(scrcpy), closed(ffmpeg)])
      .then(() => undefined)
      .finally(() => rm(directory, { recursive: true, force: true }));
    return stopping;
  };
  scrcpy.once("error", () => void stop());
  ffmpeg.once("error", () => void stop());
  scrcpy.once("close", () => {
    if (ffmpeg.exitCode === null) ffmpeg.kill("SIGTERM");
  });
  ffmpeg.once("close", () => {
    if (scrcpy.exitCode === null) scrcpy.kill("SIGTERM");
  });
  if (!ffmpeg.stdout) {
    await stop();
    throw new Error("ffmpeg stream output is unavailable");
  }
  return { stream: ffmpeg.stdout, stop };
}
