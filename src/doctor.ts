import type { AdbDevice } from "./android/adb-discovery.ts";

export interface DoctorFinding {
  status: "pass" | "fail";
  subject: string;
  message: string;
}

export function diagnoseAdbDevices(devices: readonly AdbDevice[]): DoctorFinding[] {
  if (devices.length === 0) {
    return [
      {
        status: "fail",
        subject: "Android connection",
        message:
          "No ADB device found. Unlock the phone, enable USB debugging, choose File transfer, and use a data-capable cable.",
      },
    ];
  }

  return devices.map((device) => {
    if (device.transportState === "device") {
      return {
        status: "pass",
        subject: device.serial,
        message: `${device.model ?? "Android device"} is authorized over ADB.`,
      };
    }
    if (device.transportState === "unauthorized") {
      return {
        status: "fail",
        subject: device.serial,
        message: "Unlock the phone and approve the USB debugging RSA prompt.",
      };
    }
    return {
      status: "fail",
      subject: device.serial,
      message: `ADB transport is ${device.transportState}; reconnect the cable and restart USB debugging.`,
    };
  });
}

export function formatDoctorFindings(findings: readonly DoctorFinding[]): string {
  return findings
    .map(
      ({ status, subject, message }) =>
        `${status === "pass" ? "PASS" : "FAIL"}  ${subject}: ${message}`,
    )
    .join("\n");
}

export interface SetupReport {
  status: string;
  discoveryError?: string;
  modelProvider: string | null;
  modelRequirement: string | null;
  agentConfigured: boolean;
  devices: { total: number; ready: number; states: Record<string, string> };
}

const stateAdvice: Record<string, string> = {
  locked: "Unlock the phone, or start the daemon with TAPRIG_UNLOCK_PIN set so runs unlock it.",
  unauthorized: "Unlock the phone and approve the USB debugging prompt (check Always allow).",
  offline: "ADB sees the phone but cannot talk to it: replug the cable or toggle USB debugging.",
  booting: "The phone is still booting; wait and run doctor again.",
  degraded:
    "The driver could not enroll; the phone runs on the slower UIAutomator fallback. Check the daemon log.",
};

/** Findings from the running daemon: phones, unlock state, driver, and model provider. */
export function diagnoseSetup(setup: SetupReport): DoctorFinding[] {
  const findings: DoctorFinding[] = [
    { status: "pass", subject: "daemon", message: "TapRig daemon is running and reachable." },
  ];
  if (setup.discoveryError) {
    findings.push({
      status: "fail",
      subject: "adb",
      message: `${setup.discoveryError}. Run taprig setup to download platform-tools, or install adb.`,
    });
  }
  if (setup.devices.total === 0) {
    findings.push(...diagnoseAdbDevices([]));
  }
  for (const [serial, state] of Object.entries(setup.devices.states)) {
    findings.push(
      state === "ready"
        ? {
            status: "pass",
            subject: serial,
            message: "Ready: unlocked, authorized, driver enrolled.",
          }
        : {
            status: "fail",
            subject: serial,
            message: `${state}. ${stateAdvice[state] ?? "Reconnect the phone and run doctor again."}`,
          },
    );
  }
  findings.push(
    setup.agentConfigured
      ? {
          status: "pass",
          subject: "model",
          message: `${setup.modelProvider ?? "provider"} is ready to drive runs.`,
        }
      : {
          status: "fail",
          subject: "model",
          message: `${setup.modelRequirement ?? "configure a model provider"}; then run taprig model use <provider>.`,
        },
  );
  return findings;
}
