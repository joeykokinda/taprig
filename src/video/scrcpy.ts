import { execFile } from "node:child_process";
import { access, chmod, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const scrcpyRelease = {
  version: "5.0.1",
  linuxX64Url:
    "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-linux-x86_64-v5.0.1.tar.gz",
  linuxX64Sha256: "9f969d30cc574816077edecda65719c1c70b0aee1df1ba5fa00779ac07b8fd6e",
} as const;

export type ScrcpyRunner = (executable: string, args: readonly string[]) => Promise<void>;

export async function runScrcpy(executable: string, args: readonly string[]): Promise<void> {
  await execFileAsync(executable, [...args], { maxBuffer: 4 * 1024 * 1024 });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface ScrcpyRecordingOptions {
  executable: string;
  serial: string;
  outputPath: string;
  durationSeconds: number;
  run?: ScrcpyRunner;
}

export interface VideoArtifact {
  path: string;
  bytes: number;
  durationSeconds: number;
  createdAt: string;
}

export async function recordScrcpyVideo(
  options: ScrcpyRecordingOptions,
  now = () => new Date().toISOString(),
): Promise<VideoArtifact> {
  if (!options.serial) throw new Error("device serial must not be empty");
  if (!isAbsolute(options.outputPath)) throw new Error("recording output path must be absolute");
  if (!/\.(?:mkv|mp4)$/u.test(options.outputPath)) {
    throw new Error("recording output must use .mkv or .mp4");
  }
  if (
    !Number.isSafeInteger(options.durationSeconds) ||
    options.durationSeconds < 1 ||
    options.durationSeconds > 300
  ) {
    throw new Error("recording duration must be an integer from 1 to 300 seconds");
  }
  if (await exists(options.outputPath)) throw new Error("recording output already exists");

  const run = options.run ?? runScrcpy;
  try {
    await run(options.executable, [
      "--serial",
      options.serial,
      "--no-playback",
      "--no-control",
      "--no-audio",
      "--no-window",
      `--record=${options.outputPath}`,
      `--time-limit=${options.durationSeconds}`,
    ]);
  } finally {
    if (await exists(options.outputPath)) await chmod(options.outputPath, 0o600);
  }

  const artifact = await stat(options.outputPath);
  if (!artifact.isFile() || artifact.size === 0) throw new Error("scrcpy produced no video data");
  return {
    path: options.outputPath,
    bytes: artifact.size,
    durationSeconds: options.durationSeconds,
    createdAt: now(),
  };
}
