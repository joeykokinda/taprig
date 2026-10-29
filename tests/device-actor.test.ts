import assert from "node:assert/strict";
import test from "node:test";

import type { AdbShell } from "../src/android/device-actor.ts";
import { DeviceRegistry, parseKeyguardUnlocked } from "../src/android/device-actor.ts";

const connected = {
  serial: "phone-1",
  transportState: "device",
  model: "Pixel_8",
} as const;

const properties = `[ro.product.manufacturer]: [Google]
[ro.product.model]: [Pixel 8]
[ro.product.device]: [shiba]
[ro.build.version.release]: [16]
[ro.build.version.sdk]: [36]
[sys.boot_completed]: [1]
`;

test("the registry probes connected devices and preserves them across disconnects", async () => {
  const shell: AdbShell = async (_serial, command) =>
    command === "getprop" ? properties : "keyguardShowing=false";
  const registry = new DeviceRegistry(shell, () => "2026-10-29T00:00:00.000Z");

  const ready = await registry.refresh([connected]);
  assert.equal(ready[0]?.state, "ready");
  assert.deepEqual(ready[0]?.identity, {
    manufacturer: "Google",
    model: "Pixel 8",
    product: "shiba",
    androidVersion: "16",
    sdk: "36",
  });

  const disconnected = await registry.refresh([]);
  assert.equal(disconnected[0]?.state, "offline");

  const reconnected = await registry.refresh([connected]);
  assert.equal(reconnected[0]?.state, "ready");
});

test("unauthorized devices do not run shell probes", async () => {
  let calls = 0;
  const registry = new DeviceRegistry(async () => {
    calls += 1;
    return "";
  });

  const states = await registry.refresh([{ serial: "phone-1", transportState: "unauthorized" }]);
  assert.equal(states[0]?.state, "unauthorized");
  assert.equal(calls, 0);
});

test("unknown keyguard output fails closed", () => {
  assert.equal(parseKeyguardUnlocked("unrecognized OEM output"), false);
  assert.equal(parseKeyguardUnlocked("mShowingLockscreen=true"), false);
  assert.equal(parseKeyguardUnlocked("mShowingLockscreen=false"), true);
  assert.equal(parseKeyguardUnlocked("mShowingLockscreen=false keyguardShowing=true"), false);
});
