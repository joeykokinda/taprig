import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LiveMjpegStream {
  stream: Readable;
  stop(): Promise<void>;
}

export interface LiveStreamOptions {
  serial: string;
  scrcpyExecutable: string;
  adbExecutable?: string;
  ffmpegExecutable?: string;
  framesPerSecond?: number;
  width?: number;
}

export function screenshotFallbackArguments(options: LiveStreamOptions) {
  const framesPerSecond = options.framesPerSecond ?? 5;
  const width = options.width ?? 360;
  return {
    adb: ["-s", options.serial, "exec-out", "screencap", "-p"],
    ffmpeg: [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "image2pipe",
      "-framerate",
      String(framesPerSecond),
      "-i",
      "pipe:0",
      "-vf",
      `scale=${width}:-2`,
      "-q:v",
      "5",
      "-f",
      "mpjpeg",
      "pipe:1",
    ],
  };
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
  if (process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
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
  const output = new PassThrough();
  const children: ChildProcess[] = [scrcpy, ffmpeg];
  let stopped = false;
  let selected = false;
  let fallbackLoop: Promise<void> | undefined;
  const startFallback = () => {
    if (selected || stopped) return;
    selected = true;
    if (scrcpy.exitCode === null) scrcpy.kill("SIGTERM");
    if (ffmpeg.exitCode === null) ffmpeg.kill("SIGTERM");
    const fallbackArgs = screenshotFallbackArguments(options);
    const fallback = spawn(options.ffmpegExecutable ?? "ffmpeg", fallbackArgs.ffmpeg, {
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.push(fallback);
    fallback.stdout?.pipe(output);
    fallback.once("error", (error) => output.destroy(error));
    fallbackLoop = (async () => {
      while (!stopped && fallback.stdin?.writable) {
        const { stdout } = await execFileAsync(options.adbExecutable ?? "adb", fallbackArgs.adb, {
          encoding: "buffer",
          timeout: 5_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        if (!fallback.stdin.write(stdout)) {
          await new Promise<void>((resolve) => fallback.stdin?.once("drain", resolve));
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 / (options.framesPerSecond ?? 5)));
      }
    })().catch((error: unknown) => {
      if (!stopped) output.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  };
  const fallbackTimer = setTimeout(startFallback, 1_500);
  fallbackTimer.unref();
  ffmpeg.stdout?.once("data", (chunk: Buffer) => {
    if (selected || stopped) return;
    selected = true;
    clearTimeout(fallbackTimer);
    output.write(chunk);
    ffmpeg.stdout?.pipe(output);
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopped = true;
    clearTimeout(fallbackTimer);
    for (const child of children) {
      if (child.stdin?.writable) child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    stopping = Promise.all([...children.map(closed), fallbackLoop])
      .then(() => undefined)
      .finally(async () => {
        output.end();
        await rm(directory, { recursive: true, force: true });
      });
    return stopping;
  };
  scrcpy.once("error", startFallback);
  ffmpeg.once("error", startFallback);
  scrcpy.once("close", () => {
    if (!selected) startFallback();
    else if (ffmpeg.exitCode === null) ffmpeg.kill("SIGTERM");
  });
  ffmpeg.once("close", () => {
    if (!selected) startFallback();
    else if (scrcpy.exitCode === null) scrcpy.kill("SIGTERM");
  });
  if (!ffmpeg.stdout) {
    await stop();
    throw new Error("ffmpeg stream output is unavailable");
  }
  return { stream: output, stop };
}
