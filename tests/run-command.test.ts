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
  assert.deepEqual(parseRunCommand(["--group", "social", "Reply", "to", "DMs"]), {
    mode: "independent",
    group: "social",
    task: "Reply to DMs",
  });
  assert.deepEqual(parseRunCommand(["--device=phone-1", "--device", "phone-2", "Do", "work"]), {
    mode: "independent",
    deviceIds: ["phone-1", "phone-2"],
    task: "Do work",
  });
  assert.deepEqual(parseRunCommand(["--retain-screenshots", "Open", "Settings"]), {
    mode: "independent",
    retainScreenshots: true,
    task: "Open Settings",
  });
  assert.deepEqual(parseRunCommand(["--no-retain-screenshots", "Open", "Settings"]), {
    mode: "independent",
    retainScreenshots: false,
    task: "Open Settings",
  });
});

test("rejects missing tasks and unknown modes", () => {
  assert.throws(() => parseRunCommand([]), /requires a task/);
  assert.throws(() => parseRunCommand(["--mode", "swarm", "Do it"]), /mode must be/);
  assert.throws(() => parseRunMode(undefined), /mode must be/);
  assert.throws(() => parseRunCommand(["--max-actions", "0", "Do it"]), /integer from 1/);
  assert.throws(() => parseRunCommand(["--unknown", "value", "Do it"]), /unknown run option/);
  assert.throws(
    () => parseRunCommand(["--retain-screenshots=yes", "Do it"]),
    /does not take a value/,
  );
  assert.throws(
    () => parseRunCommand(["--group", "social", "--device", "phone-1", "Do it"]),
    /not both/,
  );
});
