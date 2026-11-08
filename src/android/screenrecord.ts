import { type ChildProcess, execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunRecording {
  /** Stops the recording and pulls it to `localPath`; resolves with the file size in bytes. */
  stop(localPath: string): Promise<number>;
}

/**
 * Records the phone with Android's own `screenrecord`, so no host-side scrcpy or ffmpeg is needed.
 * ponytail: Android caps one recording at 3 minutes; longer runs keep the first 3 minutes.
 */
export function startScreenRecording(
  serial: string,
  adb = process.env.TAPRIG_ADB ?? "adb",
  spawnProcess: typeof spawn = spawn,
): RunRecording {
  const remotePath = `/sdcard/taprig-${Date.now()}.mp4`;
  const child: ChildProcess = spawnProcess(
    adb,
    [
      "-s",
      serial,
      "shell",
      "screenrecord",
      "--time-limit",
      "180",
      "--bit-rate",
      "2000000",
      remotePath,
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return {
    async stop(localPath) {
      // SIGINT on the phone side makes screenrecord finalize the file; killing adb alone would not.
      await execFileAsync(adb, ["-s", serial, "shell", "pkill", "-INT", "screenrecord"]).catch(
        () => undefined,
      );
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      child.kill();
      await execFileAsync(adb, ["-s", serial, "pull", remotePath, localPath]);
      await execFileAsync(adb, ["-s", serial, "shell", "rm", "-f", remotePath]).catch(
        () => undefined,
      );
      try {
        return statSync(localPath).size;
      } catch {
        return 0;
      }
    },
  };
}
