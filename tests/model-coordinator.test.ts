import assert from "node:assert/strict";
import test from "node:test";

import { createModelCoordinator } from "../src/agents/model-coordinator.ts";

test("turns strict model output into a validated coordinated plan", async () => {
  const usage: unknown[] = [];
  const plan = await createModelCoordinator(
    { provider: "openai", model: "test-model", reasoningEffort: "low" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async () =>
      new Response(
        JSON.stringify({
          usage: { input_tokens: 20, output_tokens: 8 },
          output_text: JSON.stringify({
            nodes: [
              {
                id: "collect",
                task: "Collect the result",
                dependsOn: [],
                deviceId: null,
                capabilities: ["semantic-observation", "semantic-action"],
              },
              {
                id: "send",
                task: "Send the collected result",
                dependsOn: ["collect"],
                deviceId: " phone-2 ",
                capabilities: ["semantic-observation"],
              },
            ],
          }),
        }),
        { status: 200 },
      ),
    (sample) => usage.push(sample),
  )("Collect and send the result");

  assert.deepEqual(plan, {
    nodes: [
      {
        id: "collect",
        task: "Collect the result",
        dependsOn: [],
        capabilities: ["semantic-observation", "semantic-action"],
      },
      {
        id: "send",
        task: "Send the collected result",
        dependsOn: ["collect"],
        deviceId: "phone-2",
        capabilities: ["semantic-observation"],
      },
    ],
  });
  assert.deepEqual(usage, [{ inputTokens: 20, outputTokens: 8, costUsd: 0 }]);
});
