import assert from "node:assert/strict";
import test from "node:test";

import { parseExecuteCommand } from "../src/execute-command.ts";

test("parses deterministic execute commands into typed actions", () => {
  assert.deepEqual(parseExecuteCommand(["phone-1", "key", "home"]), {
    serial: "phone-1",
    action: { type: "key.press", key: "home" },
  });
  assert.deepEqual(parseExecuteCommand(["phone-1", "swipe", "1", "2", "3", "4", "500"]), {
    serial: "phone-1",
    action: {
      type: "gesture.swipe",
      from: { x: 1, y: 2 },
      to: { x: 3, y: 4 },
      durationMs: 500,
    },
  });
});

test("rejects incomplete or unknown execute commands", () => {
  assert.throws(() => parseExecuteCommand([]), /device serial/);
  assert.throws(() => parseExecuteCommand(["phone-1", "tap", "x", "2"]), /x must be an integer/);
  assert.throws(
    () => parseExecuteCommand(["phone-1", "type", "hello"]),
    /must be key, tap, swipe, or launch/,
  );
});
