import assert from "node:assert/strict";
import test from "node:test";

import type { AdbShell } from "../src/android/device-actor.ts";
import {
  DeviceRegistry,
  parseForegroundActivity,
  parseKeyguardUnlocked,
  parseScreenState,
} from "../src/android/device-actor.ts";

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

test("the registry probes connected devices and preserves identity across disconnects", async () => {
  const shell: AdbShell = async (_serial, command) => {
    if (command === "getprop") return properties;
    if (command === "dumpsys window policy") return "keyguardShowing=false";
    if (command === "dumpsys power") return "mWakefulness=Awake";
    return "topResumedActivity=ActivityRecord{abc u0 com.android.settings/.Settings t12}";
  };
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
  assert.equal(ready[0]?.screenState, "awake");
  assert.deepEqual(ready[0]?.foregroundActivity, {
    packageName: "com.android.settings",
    activityName: ".Settings",
  });

  const disconnected = await registry.refresh([]);
  assert.equal(disconnected[0]?.state, "offline");
  assert.equal(disconnected[0]?.foregroundActivity, undefined);
  assert.equal(disconnected[0]?.screenState, undefined);
  assert.equal(disconnected[0]?.identity.model, "Pixel 8");

  const reconnected = await registry.refresh([connected]);
  assert.equal(reconnected[0]?.state, "ready");
});

test("parses screen power and foreground activity without guessing", () => {
  assert.equal(parseScreenState("mWakefulness=Dozing"), "dozing");
  assert.equal(parseScreenState("OEM output without wakefulness"), "unknown");
  assert.deepEqual(
    parseForegroundActivity(
      "topResumedActivity=ActivityRecord{cdef u0 com.motorola.launcher3/.QuickstepLauncher t401}",
    ),
    { packageName: "com.motorola.launcher3", activityName: ".QuickstepLauncher" },
  );
  assert.equal(parseForegroundActivity("no resumed activity"), undefined);
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
  assert.equal(
    parseKeyguardUnlocked(`KeyguardServiceDelegate
      showing=false
      KeyguardStateMonitor
        mIsShowing=false`),
    true,
  );
  assert.equal(parseKeyguardUnlocked("  showing=false\n  mIsShowing=true"), false);
});
