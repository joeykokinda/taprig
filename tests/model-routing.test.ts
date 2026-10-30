import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  defaultModelConfig,
  loadOrCreateModelConfig,
  saveModelConfig,
} from "../src/models/config.ts";
import { OpenAiResponsesProvider } from "../src/models/openai.ts";
import { routeModel } from "../src/models/router.ts";

function openAiConfig() {
  const config = defaultModelConfig().providers.openai;
  assert.ok(config);
  return config;
}

test("persists editable profiles without storing an API key", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-models-"));
  const path = join(directory, "models.json");
  context.after(() => rm(directory, { recursive: true }));

  const config = loadOrCreateModelConfig(path);
  config.selectedProfile = "economy";
  saveModelConfig(config, path);

  assert.equal(loadOrCreateModelConfig(path).selectedProfile, "economy");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path, "utf8"), /sk-/u);
});

test("routes roles through profile budgets", () => {
  const config = defaultModelConfig();
  assert.equal(
    routeModel(config, "fast", { strongCalls: 0, visionCalls: 0 })?.target.model,
    "gpt-6-luna",
  );
  assert.equal(
    routeModel(config, "strong", { strongCalls: 0, visionCalls: 0 })?.target.model,
    "gpt-6.1-sol",
  );
  assert.equal(routeModel(config, "strong", { strongCalls: 3, visionCalls: 0 }), undefined);
  assert.equal(
    routeModel(config, "vision", { strongCalls: 0, visionCalls: 0 }, "economy"),
    undefined,
  );
});

test("sends strict structured output through the Responses API", async () => {
  let authorization = "";
  let sent: Record<string, unknown> = {};
  const provider = new OpenAiResponsesProvider(
    openAiConfig(),
    { OPENAI_API_KEY: "test-key" },
    async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output_text: '{"type":"complete"}',
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
        { status: 200 },
      );
    },
  );

  const response = await provider.structured({
    model: "gpt-6-luna",
    system: "Return one decision.",
    input: "Task and phone state",
    schemaName: "taprig_decision",
    schema: { type: "object", additionalProperties: false },
    reasoningEffort: "low",
  });

  assert.equal(authorization, "Bearer test-key");
  assert.deepEqual(response, { value: { type: "complete" }, inputTokens: 9, outputTokens: 4 });
  assert.equal((sent.text as { format: { strict: boolean } }).format.strict, true);
  assert.equal(JSON.stringify(sent).includes("test-key"), false);
});

test("fails before a provider call when its API key is missing", async () => {
  const provider = new OpenAiResponsesProvider(openAiConfig(), {});
  await assert.rejects(
    provider.structured({
      model: "gpt-6-luna",
      system: "system",
      input: "input",
      schemaName: "decision",
      schema: { type: "object" },
    }),
    /OPENAI_API_KEY is not configured/,
  );
});
