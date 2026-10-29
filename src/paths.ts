import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function dataDirectory(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (environment.TAPRIG_DATA_DIR) {
    if (!isAbsolute(environment.TAPRIG_DATA_DIR)) {
      throw new Error("TAPRIG_DATA_DIR must be an absolute path");
    }
    return environment.TAPRIG_DATA_DIR;
  }
  if (platform === "win32") {
    return join(environment.APPDATA ?? join(home, "AppData", "Roaming"), "TapRig");
  }
  if (platform === "darwin") return join(home, "Library", "Application Support", "TapRig");
  return join(environment.XDG_DATA_HOME ?? join(home, ".local", "share"), "taprig");
}
