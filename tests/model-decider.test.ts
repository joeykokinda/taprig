import assert from "node:assert/strict";
import test from "node:test";

import { createModelDecider } from "../src/agents/model-decider.ts";

test("turns strict model output into a locally identified typed tap", async () => {
  const decide = createModelDecider(
    "Open Settings",
    { provider: "openai", model: "test-model", reasoningEffort: "low" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            type: "execute",
            evidence: null,
            question: null,
            reason: null,
            steps: [
              {
                id: "open",
                actionType: "tap",
                selectorType: "text",
                value: "Settings",
                role: null,
              },
            ],
          }),
        }),
        { status: 200 },
      ),
  );
  const decision = await decide({
    decisionNumber: 0,
    observation: {
      deviceId: "phone-1",
      generation: "one",
      capturedAt: "2026-10-30T16:00:00.000Z",
      elements: [{ id: "node-1", role: "TextView", text: "Settings", actionable: true }],
    },
  });
  assert.equal(decision.type, "execute");
  assert.deepEqual(decision.type === "execute" ? decision.steps : [], [
    { id: "open", action: { type: "element.tap", target: { text: "Settings" } } },
  ]);
});
