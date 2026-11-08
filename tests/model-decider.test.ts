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
  assert.deepEqual(usage, [{ inputTokens: 12, outputTokens: 3, costUsd: 0 }]);
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
  assert.deepEqual(usage, [{ inputTokens: 0, outputTokens: 0, costUsd: 0 }]);
});

test("parses a strict explicit approval request", async () => {
  const decide = createModelDecider(
    "Ask me before sending",
    { provider: "openai", model: "test-model" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            type: "request_approval",
            evidence: null,
            question: null,
            approval: "Send the drafted message?",
            reason: null,
            steps: [],
          }),
        }),
      ),
  );
  const decision = await decide({
    decisionNumber: 0,
    observation: {
      deviceId: "phone-1",
      generation: "one",
      capturedAt: "2026-11-02T12:00:00.000Z",
      elements: [],
    },
  });
  assert.deepEqual(decision, { type: "request_approval", prompt: "Send the drafted message?" });
});

test("routes the durable autonomous policy into the model contract", async () => {
  let requestBody = "";
  const decide = createModelDecider(
    "Send the message",
    { provider: "openai", model: "test-model" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async (_input, init) => {
      requestBody = String(init?.body);
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            type: "complete",
            evidence: "Done",
            question: null,
            approval: null,
            reason: null,
            steps: [],
          }),
        }),
      );
    },
    undefined,
    "autonomous",
  );
  await decide({
    decisionNumber: 0,
    observation: {
      deviceId: "phone-1",
      generation: "one",
      capturedAt: "2026-11-04T12:00:00.000Z",
      elements: [],
    },
  });
  assert.match(requestBody, /Never request approval/);
});

test("rejects an approval pause that violates autonomous policy", async () => {
  const decide = createModelDecider(
    "Send without pausing",
    { provider: "openai", model: "test-model" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            type: "request_approval",
            evidence: null,
            question: null,
            approval: "Send now?",
            reason: null,
            steps: [],
          }),
        }),
      ),
    undefined,
    "autonomous",
  );
  await assert.rejects(
    decide({
      decisionNumber: 0,
      observation: {
        deviceId: "phone-1",
        generation: "one",
        capturedAt: "2026-11-04T12:00:00.000Z",
        elements: [],
      },
    }),
    /violated the autonomous approval policy/,
  );
});

test("swaps positional element IDs for unique semantic selectors and scrolls by direction", async () => {
  let sentInput = "";
  const decide = createModelDecider(
    "Open Display",
    { provider: "openai", model: "test-model" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async (_input, init) => {
      sentInput = String(init?.body);
      const step = (id: string, actionType: string, selectorType: string, value: string) => ({
        id,
        actionType,
        selectorType,
        value,
        input: null,
        role: null,
      });
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            type: "execute",
            evidence: null,
            question: null,
            approval: null,
            reason: null,
            steps: [
              step("unique", "tap", "elementId", "node-2"),
              step("repeated", "longTap", "elementId", "node-4"),
              step("more", "scroll", "text", "down"),
            ],
          }),
        }),
        { status: 200 },
      );
    },
  );
  const decision = await decide({
    decisionNumber: 1,
    history: [
      {
        decisionNumber: 0,
        steps: [{ action: { type: "key.press", key: "home" }, status: "verified" }],
      },
    ],
    observation: {
      deviceId: "phone-1",
      generation: "two",
      capturedAt: "2026-11-07T00:00:00.000Z",
      elements: [
        {
          id: "node-0",
          role: "FrameLayout",
          actionable: false,
          bounds: { left: 0, top: 0, right: 1000, bottom: 2000 },
        },
        { id: "node-1", role: "TextView", text: "Display", actionable: false },
        { id: "node-2", role: "LinearLayout", text: "Display", actionable: true },
        { id: "node-3", role: "Switch", text: "On", actionable: true },
        { id: "node-4", role: "Switch", text: "On", actionable: true },
      ],
    },
  });
  assert.deepEqual(decision.type === "execute" ? decision.steps.map((step) => step.action) : [], [
    { type: "element.tap", target: { text: "Display", role: "LinearLayout" } },
    { type: "element.longTap", target: { elementId: "node-4" } },
    { type: "gesture.swipe", from: { x: 500, y: 1500 }, to: { x: 500, y: 600 }, durationMs: 350 },
  ]);
  assert.match(sentInput, /recentActions/u);
  assert.doesNotMatch(sentInput, /FrameLayout/u);
});

test("attaches a screenshot on thin semantic screens and maps tapPoint to pixels", async () => {
  let sent: { input: Array<{ content: unknown }> } = { input: [] };
  const png = Buffer.alloc(24);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(720, 16);
  png.writeUInt32BE(1600, 20);
  const decide = createModelDecider(
    "Tap the play button in the game",
    { provider: "openai", model: "test-model" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            type: "execute",
            evidence: null,
            question: null,
            approval: null,
            reason: null,
            steps: [
              {
                id: "play",
                actionType: "tapPoint",
                selectorType: "text",
                value: "500,750",
                input: null,
                role: null,
              },
            ],
          }),
        }),
        { status: 200 },
      );
    },
    undefined,
    "explicit",
    async () => png,
  );
  const decision = await decide({
    decisionNumber: 0,
    observation: {
      deviceId: "phone-1",
      generation: "g",
      capturedAt: "2026-11-07T00:00:00.000Z",
      elements: [{ id: "node-0", role: "SurfaceView", actionable: false }],
    },
  });
  assert.deepEqual(decision.type === "execute" ? decision.steps[0]?.action : undefined, {
    type: "gesture.tap",
    x: 360,
    y: 1200,
  });
  assert.match(JSON.stringify(sent.input[1]?.content), /data:image\/png;base64,/u);
});

test("feeds one malformed decision back to the model and accepts loosely spelled scroll directions", async () => {
  const inputs: string[] = [];
  const usage: unknown[] = [];
  const step = (actionType: string, value: string) => ({
    id: "s1",
    actionType,
    selectorType: "text",
    value,
    input: null,
    role: null,
  });
  const answers = [step("key", "volume"), step("scroll", "Scroll Down")];
  const decide = createModelDecider(
    "Scroll",
    { provider: "openai", model: "test-model" },
    { type: "openai", apiKeyEnv: "TEST_KEY", baseUrl: "https://example.test/v1" },
    { TEST_KEY: "secret" },
    async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: Array<{ content: string }> };
      inputs.push(body.input[1]?.content ?? "");
      const execute = {
        type: "execute",
        evidence: null,
        question: null,
        approval: null,
        reason: null,
        steps: [answers[inputs.length - 1]],
      };
      return new Response(JSON.stringify({ output_text: JSON.stringify(execute) }), {
        status: 200,
      });
    },
    (used) => usage.push(used),
  );
  const observation = {
    deviceId: "phone-1",
    generation: "one",
    capturedAt: "2026-11-07T00:00:00.000Z",
    elements: [],
  };
  const decision = await decide({ decisionNumber: 0, observation });
  assert.equal(inputs.length, 2);
  assert.match(inputs[1] ?? "", /rejectedDecision.*invalid key/u);
  assert.equal(usage.length, 2);
  assert.equal(decision.type === "execute" ? decision.steps[0]?.action.type : "", "gesture.swipe");

  answers.splice(0, 2, step("key", "volume"), step("key", "volume"));
  inputs.length = 0;
  await assert.rejects(decide({ decisionNumber: 1, observation }), /invalid key/u);
  assert.equal(inputs.length, 2);
});
