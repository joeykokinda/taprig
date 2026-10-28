import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AdbTransportState = "device" | "offline" | "unauthorized" | "unknown";

export interface AdbDevice {
  serial: string;
  transportState: AdbTransportState;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
}

export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];

  for (const line of output.split(/\r?\n/u).slice(1)) {
    const fields = line.trim().split(/\s+/u);
    const serial = fields[0];
    const rawState = fields[1];
    if (!serial || !rawState || line.startsWith("* daemon")) continue;

    const properties = new Map<string, string>();
    for (const field of fields.slice(2)) {
      const separator = field.indexOf(":");
      if (separator > 0) properties.set(field.slice(0, separator), field.slice(separator + 1));
    }

    const product = properties.get("product");
    const model = properties.get("model");
    const device = properties.get("device");
    const transportId = properties.get("transport_id");

    devices.push({
      serial,
      transportState:
        rawState === "device" || rawState === "offline" || rawState === "unauthorized"
          ? rawState
          : "unknown",
      ...(product ? { product } : {}),
      ...(model ? { model } : {}),
      ...(device ? { device } : {}),
      ...(transportId ? { transportId } : {}),
    });
  }

  return devices.sort((left, right) => left.serial.localeCompare(right.serial));
}

export function formatAdbDevices(devices: readonly AdbDevice[]): string {
  if (devices.length === 0)
    return "No Android devices found. Connect a phone with USB debugging enabled.";

  return [
    "SERIAL\tSTATE\tMODEL",
    ...devices.map(
      ({ serial, transportState, model }) => `${serial}\t${transportState}\t${model ?? "-"}`,
    ),
  ].join("\n");
}

export async function discoverAdbDevices(adbPath = "adb"): Promise<AdbDevice[]> {
  const { stdout } = await execFileAsync(adbPath, ["devices", "-l"]);
  return parseAdbDevices(stdout);
}
