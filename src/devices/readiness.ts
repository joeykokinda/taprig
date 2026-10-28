import type { AdbTransportState } from "../android/adb-discovery.ts";
import type { DeviceCapability, DeviceId } from "../core/contracts.ts";

export interface DeviceFact<T> {
  value: T;
  source: string;
  observedAt: string;
  expiresAt?: string;
}

export type CapabilityState = "available" | "unavailable" | "unverified";

export interface DeviceSnapshot {
  deviceId: DeviceId;
  serial: string;
  transport: DeviceFact<AdbTransportState>;
  bootCompleted: DeviceFact<boolean>;
  unlocked: DeviceFact<boolean>;
  unlockCredentialAvailable: boolean;
  internet: DeviceFact<boolean>;
  packages: Readonly<Record<string, string>>;
  capabilities: Readonly<Partial<Record<DeviceCapability, CapabilityState>>>;
}

export interface TaskRequirements {
  capabilities?: readonly DeviceCapability[];
  packages?: readonly string[];
  internet?: boolean;
}

export type FaultScope = "transport" | "device" | "network" | "app" | "task";
export type Repairability = "automatic" | "needs-information" | "needs-user" | "unsupported";

export interface ReadinessFault {
  code: string;
  scope: FaultScope;
  repairability: Repairability;
  message: string;
  remediationId?: string;
}

export interface ReadinessReport {
  deviceId: DeviceId;
  ready: boolean;
  faults: readonly ReadinessFault[];
}

function isExpired(fact: DeviceFact<unknown>, now: string): boolean {
  return fact.expiresAt !== undefined && fact.expiresAt <= now;
}

export function diagnoseReadiness(
  snapshot: DeviceSnapshot,
  requirements: TaskRequirements,
  now = new Date().toISOString(),
): ReadinessReport {
  const faults: ReadinessFault[] = [];
  const liveFacts = [
    snapshot.transport,
    snapshot.bootCompleted,
    snapshot.unlocked,
    snapshot.internet,
  ];

  if (liveFacts.some((fact) => isExpired(fact, now))) {
    faults.push({
      code: "state-stale",
      scope: "device",
      repairability: "automatic",
      message: "Device readiness facts must be refreshed",
      remediationId: "device.refresh",
    });
  } else if (snapshot.transport.value === "unauthorized") {
    faults.push({
      code: "adb-unauthorized",
      scope: "transport",
      repairability: "needs-user",
      message: "Approve this computer on the Android device",
    });
  } else if (snapshot.transport.value !== "device") {
    faults.push({
      code: "adb-unavailable",
      scope: "transport",
      repairability: "automatic",
      message: `ADB transport is ${snapshot.transport.value}`,
      remediationId: "adb.reconnect",
    });
  } else if (!snapshot.bootCompleted.value) {
    faults.push({
      code: "device-booting",
      scope: "device",
      repairability: "automatic",
      message: "Android has not completed booting",
      remediationId: "device.wait-for-boot",
    });
  } else if (!snapshot.unlocked.value) {
    faults.push({
      code: "device-locked",
      scope: "device",
      repairability: snapshot.unlockCredentialAvailable ? "automatic" : "needs-information",
      message: snapshot.unlockCredentialAvailable
        ? "The device must be unlocked with its configured secret"
        : "Configure an authorized device unlock secret",
      ...(snapshot.unlockCredentialAvailable ? { remediationId: "device.unlock" } : {}),
    });
  }

  if (faults.length > 0) return { deviceId: snapshot.deviceId, ready: false, faults };

  if (requirements.internet && !snapshot.internet.value) {
    faults.push({
      code: "internet-unavailable",
      scope: "network",
      repairability: "automatic",
      message: "The task requires working internet access",
      remediationId: "network.restore",
    });
  }

  for (const packageName of requirements.packages ?? []) {
    if (!(packageName in snapshot.packages)) {
      faults.push({
        code: "package-missing",
        scope: "app",
        repairability: "needs-information",
        message: `Required package ${packageName} is not installed`,
        remediationId: "package.install",
      });
    }
  }

  for (const capability of requirements.capabilities ?? []) {
    const state = snapshot.capabilities[capability] ?? "unverified";
    if (state !== "available") {
      faults.push({
        code: state === "unavailable" ? "capability-unavailable" : "capability-unverified",
        scope: "task",
        repairability: state === "unavailable" ? "unsupported" : "automatic",
        message: `Required capability ${capability} is ${state}`,
        ...(state === "unverified" ? { remediationId: "capability.verify" } : {}),
      });
    }
  }

  return { deviceId: snapshot.deviceId, ready: faults.length === 0, faults };
}
