import assert from "node:assert/strict";
import test from "node:test";

import type { AdbCommandRunner } from "../src/android/raw-actions.ts";
import {
  executeNormalizedTap,
  executeRawAction,
  parseRawAction,
} from "../src/android/raw-actions.ts";

test("raw actions pass validated arguments without shell interpolation", async () => {
  const calls: Array<{ serial: string; args: readonly string[] }> = [];
  const run: AdbCommandRunner = async (serial, args) => {
    calls.push({ serial, args });
  };

  await executeRawAction("phone-1", { type: "key.press", key: "home" }, run);
  await executeRawAction("phone-1", { type: "gesture.tap", x: 100, y: 200 }, run);
  await executeRawAction(
    "phone-1",
    { type: "app.launch", packageName: "com.android.settings" },
    run,
  );

  assert.deepEqual(calls, [
    { serial: "phone-1", args: ["input", "keyevent", "KEYCODE_HOME"] },
    { serial: "phone-1", args: ["input", "tap", "100", "200"] },
    {
      serial: "phone-1",
      args: ["monkey", "-p", "com.android.settings", "-c", "android.intent.category.LAUNCHER", "1"],
    },
  ]);
});

test("raw actions reject unsafe values and semantic-only operations", async () => {
  await assert.rejects(
    executeRawAction("phone-1", { type: "app.launch", packageName: "bad;command" }, async () => {}),
    /invalid Android package name/,
  );
  await assert.rejects(
    executeRawAction("phone-1", { type: "gesture.tap", x: -1, y: 0 }, async () => {}),
    /coordinates/,
  );
  await assert.rejects(
    executeRawAction(
      "phone-1",
      { type: "element.tap", target: { text: "Settings" } },
      async () => {},
    ),
    /requires the TapRig semantic driver/,
  );
});

test("parses only the bounded raw action API", () => {
  assert.deepEqual(parseRawAction({ type: "key.press", key: "home" }), {
    type: "key.press",
    key: "home",
  });
  assert.throws(() => parseRawAction({ type: "shell", command: "whoami" }), /unsupported/);
  assert.throws(() => parseRawAction({ type: "gesture.tap", x: "1", y: 2 }), /malformed/);
});

test("maps a normalized manual tap to the current Android display", async () => {
  let args: readonly string[] = [];
  await executeNormalizedTap(
    "phone-1",
    0.5,
    0.25,
    async () => "Physical size: 720x1600\n",
    async (_serial, next) => {
      args = next;
    },
  );
  assert.deepEqual(args, ["input", "tap", "360", "400"]);
  await assert.rejects(executeNormalizedTap("phone-1", 2, 0.5), /0 to 1/);
});
