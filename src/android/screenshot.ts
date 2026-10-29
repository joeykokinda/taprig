import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const maximumScreenshotBytes = 25 * 1024 * 1024;

export type ScreenshotRunner = (serial: string) => Promise<Buffer>;

export async function captureAdbScreenshot(serial: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("adb", ["-s", serial, "exec-out", "screencap", "-p"], {
    encoding: "buffer",
    maxBuffer: maximumScreenshotBytes,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

export interface ScreenshotArtifact {
  path: string;
  bytes: number;
  capturedAt: string;
}

export async function captureScreenshot(
  serial: string,
  outputPath: string,
  run: ScreenshotRunner = captureAdbScreenshot,
  now = () => new Date().toISOString(),
): Promise<ScreenshotArtifact> {
  if (!serial) throw new Error("device serial must not be empty");
  const image = await run(serial);
  if (image.length > maximumScreenshotBytes) throw new Error("screenshot exceeds 25 MiB limit");
  if (image.length < pngSignature.length || !image.subarray(0, 8).equals(pngSignature)) {
    throw new Error("device did not return a valid PNG screenshot");
  }

  await writeFile(outputPath, image, { flag: "wx", mode: 0o600 });
  return { path: outputPath, bytes: image.length, capturedAt: now() };
}
