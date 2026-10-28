import assert from "node:assert/strict";
import test from "node:test";

import type { AdbTransportState } from "../src/android/adb-discovery.ts";
import type { DeviceFact, DeviceSnapshot } from "../src/devices/readiness.ts";
import { diagnoseReadiness } from "../src/devices/readiness.ts";
import { assignDevice } from "../src/orchestration/scheduler.ts";

const observedAt = "2026-10-28T12:00:00.000Z";
const expiresAt = "2026-10-28T12:05:00.000Z";
const fact = <T>(value: T): DeviceFact<T> => ({ value, source: "test", observedAt, expiresAt });

function snapshot(deviceId: string): DeviceSnapshot {
  return {
    deviceId,
    serial: deviceId,
    transport: fact("device"),
    bootCompleted: fact(true),
    unlocked: fact(true),
    unlockCredentialAvailable: false,
    internet: fact(true),
    packages: { "com.zhiliaoapp.musically": "42.0.0" },
    capabilities: { "semantic-action": "available", screenshot: "available" },
  };
}

const requirements = {
  internet: true,
  packages: ["com.zhiliaoapp.musically"],
  capabilities: ["semantic-action"],
} as const;

test("diagnoses repairable prerequisites instead of assigning an unready phone", () => {
  const unready = {
    ...snapshot("phone-1"),
    internet: fact(false),
    packages: {},
  };

  assert.deepEqual(diagnoseReadiness(unready, requirements, observedAt).faults, [
    {
      code: "internet-unavailable",
      scope: "network",
      repairability: "automatic",
      message: "The task requires working internet access",
      remediationId: "network.restore",
    },
    {
      code: "package-missing",
      scope: "app",
      repairability: "needs-information",
      message: "Required package com.zhiliaoapp.musically is not installed",
      remediationId: "package.install",
    },
  ]);
});

test("assigns the first ready device deterministically", () => {
  const offline = {
    ...snapshot("phone-a"),
    transport: fact<AdbTransportState>("offline"),
  };
  const result = assignDevice([snapshot("phone-b"), offline], requirements, observedAt);

  assert.deepEqual(result, {
    assigned: true,
    deviceId: "phone-b",
    report: { deviceId: "phone-b", ready: true, faults: [] },
  });
});

test("requires expired device facts to be refreshed", () => {
  const report = diagnoseReadiness(snapshot("phone-1"), requirements, expiresAt);

  assert.equal(report.ready, false);
  assert.equal(report.faults[0]?.code, "state-stale");
  assert.equal(report.faults[0]?.remediationId, "device.refresh");
});

test("routes a configured lock credential to automatic unlock remediation", () => {
  const locked = {
    ...snapshot("phone-1"),
    unlocked: fact(false),
    unlockCredentialAvailable: true,
  };
  const report = diagnoseReadiness(locked, requirements, observedAt);

  assert.equal(report.ready, false);
  assert.deepEqual(report.faults[0], {
    code: "device-locked",
    scope: "device",
    repairability: "automatic",
    message: "The device must be unlocked with its configured secret",
    remediationId: "device.unlock",
  });
});

test("does not infer downstream faults through an unavailable transport", () => {
  const disconnected = {
    ...snapshot("phone-1"),
    transport: fact<AdbTransportState>("offline"),
    internet: fact(false),
    packages: {},
  };
  const report = diagnoseReadiness(disconnected, requirements, observedAt);

  assert.equal(report.faults.length, 1);
  assert.equal(report.faults[0]?.code, "adb-unavailable");
});
