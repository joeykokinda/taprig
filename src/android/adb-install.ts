import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";

import { findExecutable } from "../models/providers.ts";
import { dataDirectory } from "../paths.ts";

const execFileAsync = promisify(execFile);

const platformToolsArchive: Partial<Record<NodeJS.Platform, string>> = {
  linux: "platform-tools-latest-linux.zip",
  darwin: "platform-tools-latest-darwin.zip",
  win32: "platform-tools-latest-windows.zip",
};

export function adbBinaryName(platform = process.platform): string {
  return platform === "win32" ? "adb.exe" : "adb";
}

/** Where TapRig keeps its own platform-tools when the machine has none. */
export function managedAdbPath(platform = process.platform, directory = dataDirectory()): string {
  return join(directory, "platform-tools", adbBinaryName(platform));
}

export type DownloadArchive = (url: string, destination: string) => Promise<void>;

async function downloadWithFetch(url: string, destination: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
}

/**
 * Puts a working adb on PATH for this process, downloading Google's platform-tools into the
 * data directory when neither TAPRIG_ADB nor PATH has one. Returns the adb that will be used.
 */
export async function ensureAdbOnPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  directory = dataDirectory(platform, environment),
  download: DownloadArchive = downloadWithFetch,
): Promise<string> {
  const configured = environment.TAPRIG_ADB ?? adbBinaryName(platform);
  const found = findExecutable(configured, environment);
  if (found) return found;
  const managed = managedAdbPath(platform, directory);
  if (!existsSync(managed)) {
    const archive = platformToolsArchive[platform];
    if (!archive)
      throw new Error(`adb is not installed and TapRig cannot download it for ${platform}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const zip = join(directory, archive);
    await download(`https://dl.google.com/android/repository/${archive}`, zip);
    // Windows ships bsdtar, which reads zips; everywhere else has unzip.
    const extracted = join(directory, `platform-tools.${process.pid}`);
    mkdirSync(extracted, { recursive: true });
    await execFileAsync(
      platform === "win32" ? "tar" : "unzip",
      platform === "win32" ? ["-xf", zip, "-C", extracted] : ["-q", zip, "-d", extracted],
    );
    renameSync(join(extracted, "platform-tools"), dirname(managed));
    rmSync(extracted, { recursive: true, force: true });
    rmSync(zip, { force: true });
    if (platform !== "win32") chmodSync(managed, 0o755);
  }
  environment.PATH = `${dirname(managed)}${delimiter}${environment.PATH ?? ""}`;
  return managed;
}
