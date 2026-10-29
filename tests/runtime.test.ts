import assert from "node:assert/strict";
import test from "node:test";

import type { AdbDevice } from "../src/android/adb-discovery.ts";
import { DeviceRegistry } from "../src/android/device-actor.ts";
import { startRuntime } from "../src/daemon/runtime.ts";

const token = "runtime-test-token";
const headers = { authorization: `Bearer ${token}` };
const device: AdbDevice = { serial: "phone-1", transportState: "device" };
const properties = `[ro.product.model]: [Test Phone]
[sys.boot_completed]: [1]
`;

test("runtime composes discovery, device actors, and authenticated inventory", async (context) => {
  let discovered: readonly AdbDevice[] = [device];
  const registry = new DeviceRegistry(async (_serial, command) =>
    command === "getprop" ? properties : "keyguardShowing=false",
  );
  const runtime = await startRuntime({
    token,
    registry,
    discover: async () => discovered,
    pollIntervalMs: 60_000,
  });
  context.after(() => runtime.stop());

  const readyResponse = await fetch(`${runtime.url}/devices`, { headers });
  const ready = (await readyResponse.json()) as { devices: Array<{ state: string }> };
  assert.equal(ready.devices[0]?.state, "ready");

  discovered = [];
  await runtime.refresh();
  const offlineResponse = await fetch(`${runtime.url}/devices`, { headers });
  const offline = (await offlineResponse.json()) as { devices: Array<{ state: string }> };
  assert.equal(offline.devices[0]?.state, "offline");
});

test("a discovery failure fails closed to offline", async (context) => {
  let fail = false;
  const registry = new DeviceRegistry(async (_serial, command) =>
    command === "getprop" ? properties : "keyguardShowing=false",
  );
  const runtime = await startRuntime({
    token,
    registry,
    discover: async () => {
      if (fail) throw new Error("ADB unavailable");
      return [device];
    },
    pollIntervalMs: 60_000,
  });
  context.after(() => runtime.stop());

  fail = true;
  await assert.rejects(runtime.refresh(), /ADB unavailable/);
  const response = await fetch(`${runtime.url}/devices`, { headers });
  const body = (await response.json()) as { devices: Array<{ state: string }> };
  assert.equal(body.devices[0]?.state, "offline");

  fail = false;
  await runtime.refresh();
  const recoveredResponse = await fetch(`${runtime.url}/devices`, { headers });
  const recovered = (await recoveredResponse.json()) as { devices: Array<{ state: string }> };
  assert.equal(recovered.devices[0]?.state, "ready");
});
