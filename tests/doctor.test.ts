import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseAdbDevices, formatDoctorFindings } from "../src/doctor.ts";

test("doctor gives actionable setup guidance when no phone is visible", () => {
  const findings = diagnoseAdbDevices([]);

  assert.equal(findings[0]?.status, "fail");
  assert.match(formatDoctorFindings(findings), /enable USB debugging/);
  assert.match(formatDoctorFindings(findings), /data-capable cable/);
});

test("doctor distinguishes authorization from a ready transport", () => {
  const findings = diagnoseAdbDevices([
    { serial: "phone-a", transportState: "unauthorized" },
    { serial: "phone-b", transportState: "device", model: "Pixel_8" },
  ]);

  assert.match(findings[0]?.message ?? "", /approve the USB debugging RSA prompt/);
  assert.deepEqual(findings[1], {
    status: "pass",
    subject: "phone-b",
    message: "Pixel_8 is authorized over ADB.",
  });
});

test("doctor turns the daemon setup report into one fix per failure", async () => {
  const { diagnoseSetup } = await import("../src/doctor.ts");
  const findings = diagnoseSetup({
    status: "needs-attention",
    modelProvider: null,
    modelRequirement:
      "set ANTHROPIC_API_KEY or OPENAI_API_KEY, or sign in to the claude or codex CLI",
    agentConfigured: false,
    devices: { total: 2, ready: 1, states: { "phone-1": "ready", "phone-2": "locked" } },
  });
  assert.deepEqual(
    findings.map(({ status, subject }) => `${status}:${subject}`),
    ["pass:daemon", "pass:phone-1", "fail:phone-2", "fail:model"],
  );
  assert.match(findings[2]?.message ?? "", /TAPRIG_UNLOCK_PIN/u);
  assert.match(findings[3]?.message ?? "", /taprig model use/u);
});
