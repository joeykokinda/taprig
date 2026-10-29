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
