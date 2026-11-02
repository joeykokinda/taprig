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
  assert.deepEqual(
    parseRunCommand([
      "--max-actions=12",
      "--mode",
      "broadcast",
      "--max-model-calls",
      "5",
      "Open",
      "Settings",
    ]),
    {
      mode: "broadcast",
      budget: { maxActions: 12, maxModelCalls: 5 },
      task: "Open Settings",
    },
  );
});

test("rejects missing tasks and unknown modes", () => {
  assert.throws(() => parseRunCommand([]), /requires a task/);
  assert.throws(() => parseRunCommand(["--mode", "swarm", "Do it"]), /mode must be/);
  assert.throws(() => parseRunMode(undefined), /mode must be/);
  assert.throws(() => parseRunCommand(["--max-actions", "0", "Do it"]), /integer from 1/);
  assert.throws(() => parseRunCommand(["--unknown", "value", "Do it"]), /unknown run option/);
});
