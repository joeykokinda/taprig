import assert from "node:assert/strict";
import test from "node:test";

import { createModelCoordinator } from "../src/agents/model-coordinator.ts";

test("turns strict model output into a validated coordinated plan", async () => {
  const plan = await createModelCoordinator(
    { provider: "openai", model: "test-model", reasoningEffort: "low" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            nodes: [
              { id: "collect", task: "Collect the result", dependsOn: [], deviceId: null },
              {
                id: "send",
                task: "Send the collected result",
                dependsOn: ["collect"],
                deviceId: " phone-2 ",
              },
            ],
          }),
        }),
        { status: 200 },
      ),
  )("Collect and send the result");

  assert.deepEqual(plan, {
    nodes: [
      { id: "collect", task: "Collect the result", dependsOn: [] },
      {
        id: "send",
        task: "Send the collected result",
        dependsOn: ["collect"],
        deviceId: "phone-2",
      },
    ],
  });
});
