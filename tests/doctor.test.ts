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
