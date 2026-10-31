import assert from "node:assert/strict";
import test from "node:test";

import { parseRunCommand, parseRunMode } from "../src/run-command.ts";

test("parses independent and explicit fleet run modes", () => {
  assert.deepEqual(parseRunCommand(["Open", "Settings"]), {
    mode: "independent",
    task: "Open Settings",
  });
  assert.deepEqual(parseRunCommand(["--mode", "broadcast", "Open", "Settings"]), {
    mode: "broadcast",
    task: "Open Settings",
  });
  assert.deepEqual(parseRunCommand(["--mode=coordinated", "Collect", "results"]), {
    mode: "coordinated",
    task: "Collect results",
  });
});

test("rejects missing tasks and unknown modes", () => {
  assert.throws(() => parseRunCommand([]), /requires a task/);
  assert.throws(() => parseRunCommand(["--mode", "swarm", "Do it"]), /mode must be/);
  assert.throws(() => parseRunMode(undefined), /mode must be/);
});
