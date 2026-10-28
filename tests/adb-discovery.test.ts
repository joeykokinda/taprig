import assert from "node:assert/strict";
import test from "node:test";

import { formatAdbDevices, parseAdbDevices } from "../src/android/adb-discovery.ts";

test("parses and classifies ADB devices deterministically", () => {
  const output = `List of devices attached
phone-b\tunauthorized usb:1-2 transport_id:2
phone-a\tdevice product:husky model:Pixel_8_Pro device:husky transport_id:1
phone-c\toffline transport_id:3
`;

  assert.deepEqual(parseAdbDevices(output), [
    {
      serial: "phone-a",
      transportState: "device",
      product: "husky",
      model: "Pixel_8_Pro",
      device: "husky",
      transportId: "1",
    },
    { serial: "phone-b", transportState: "unauthorized", transportId: "2" },
    { serial: "phone-c", transportState: "offline", transportId: "3" },
  ]);
});

test("formats an empty discovery result with the required setup action", () => {
  assert.equal(
    formatAdbDevices([]),
    "No Android devices found. Connect a phone with USB debugging enabled.",
  );
});
