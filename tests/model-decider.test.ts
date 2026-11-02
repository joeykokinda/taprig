import assert from "node:assert/strict";
import test from "node:test";

import { createModelDecider } from "../src/agents/model-decider.ts";

test("turns strict model output into a locally identified typed tap", async () => {
  const usage: unknown[] = [];
  const decide = createModelDecider(
    "Open Settings",
    { provider: "openai", model: "test-model", reasoningEffort: "low" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async () =>
      new Response(
        JSON.stringify({
          usage: { input_tokens: 12, output_tokens: 3 },
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
                input: null,
                role: null,
              },
            ],
          }),
        }),
        { status: 200 },
      ),
    (sample) => usage.push(sample),
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
  assert.deepEqual(usage, [{ inputTokens: 12, outputTokens: 3 }]);
});

test("turns model text entry into a typed clearing semantic action", async () => {
  const decide = createModelDecider(
    "Enter the code",
    { provider: "openai", model: "test-model" },
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
                id: "code",
                actionType: "text",
                selectorType: "resourceId",
                value: "code-input",
                input: "123456",
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
      elements: [{ id: "node-1", role: "EditText", resourceId: "code-input", actionable: true }],
    },
  });
  assert.deepEqual(decision.type === "execute" ? decision.steps : [], [
    {
      id: "code",
      action: {
        type: "element.text",
        target: { resourceId: "code-input" },
        value: "123456",
        clear: true,
      },
    },
  ]);
});

test("records a failed provider attempt without inventing token usage", async () => {
  const usage: unknown[] = [];
  const decide = createModelDecider(
    "Open Settings",
    { provider: "openai", model: "test-model" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async () => new Response("failed", { status: 500 }),
    (sample) => usage.push(sample),
  );
  await assert.rejects(
    decide({
      decisionNumber: 0,
      observation: {
        deviceId: "phone-1",
        generation: "one",
        capturedAt: "2026-10-30T16:00:00.000Z",
        elements: [],
      },
    }),
    /HTTP 500/,
  );
  assert.deepEqual(usage, [{ inputTokens: 0, outputTokens: 0 }]);
});
