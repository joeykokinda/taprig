import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";

import {
  defaultModelConfig,
  defaultProviders,
  detectProvider,
  presetProfiles,
  usableModelConfig,
} from "../src/models/config.ts";
import { createStructuredProvider, type RunCommand } from "../src/models/providers.ts";

const request = {
  model: "claude-sonnet-5-5",
  system: "Return one decision.",
  input: "Task and phone state",
  schemaName: "decision",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: { id: { type: "string", minLength: 1, maxLength: 80 } },
  },
  reasoningEffort: "low" as const,
};

test("sends Claude structured output with refusal fallbacks and no unsupported constraints", async () => {
  let sent: Record<string, unknown> = {};
  let headers = new Headers();
  const provider = createStructuredProvider(
    defaultProviders.anthropic,
    { ANTHROPIC_API_KEY: "test-key" },
    async (_input, init) => {
      headers = new Headers(init?.headers);
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: '{"id":"done"}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 12, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  assert.deepEqual(await provider.structured(request), {
    value: { id: "done" },
    inputTokens: 12,
    outputTokens: 5,
  });
  assert.equal(headers.get("authorization"), "Bearer test-key");
  assert.match(headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/u);
  assert.equal(sent.fallbacks, "default");
  assert.deepEqual(sent.output_config, {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
    effort: "low",
  });
});

test("omits effort and fallbacks for Haiku 4.5 and surfaces refusals", async () => {
  let sent: Record<string, unknown> = {};
  const provider = createStructuredProvider(
    defaultProviders.anthropic,
    { ANTHROPIC_API_KEY: "test-key" },
    async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "msg_2",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [],
          stop_reason: "refusal",
          usage: { input_tokens: 1, output_tokens: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  await assert.rejects(provider.structured({ ...request, model: "claude-haiku-4-5" }), /declined/);
  assert.equal("fallbacks" in sent, false);
  assert.equal("effort" in (sent.output_config as object), false);
});

test("drives a signed-in Claude Code CLI without tools, settings, or session state", async () => {
  let call: { command: string; args: readonly string[]; input: string; cwd: string } | undefined;
  const run: RunCommand = async (command, args, options) => {
    call = { command, args, input: options.input, cwd: options.cwd };
    return JSON.stringify({
      type: "result",
      is_error: false,
      structured_output: { id: "done" },
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  };
  const provider = createStructuredProvider(defaultProviders.claude, {}, fetch, run);
  assert.deepEqual(await provider.structured({ ...request, model: "haiku" }), {
    value: { id: "done" },
    inputTokens: 3,
    outputTokens: 2,
  });
  assert.ok(call);
  assert.equal(call.command, "claude");
  assert.equal(call.input, request.input);
  const args = call.args;
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "");
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.ok(args.includes("--no-session-persistence"));
  assert.doesNotMatch(args[args.indexOf("--json-schema") + 1] ?? "", /minLength/u);
  assert.match(call.cwd, /taprig-claude-/u);

  const failing = createStructuredProvider(defaultProviders.claude, {}, fetch, async () =>
    JSON.stringify({ is_error: true, result: "Not logged in" }),
  );
  await assert.rejects(failing.structured(request), /Not logged in/);
});

test("drives a signed-in Codex CLI through a read-only sandbox and output schema file", async () => {
  let args: readonly string[] = [];
  const run: RunCommand = async (_command, received) => {
    args = received;
    await writeFile(received[received.indexOf("--output-last-message") + 1] ?? "", '{"id":"done"}');
    return "";
  };
  const provider = createStructuredProvider(defaultProviders.codex, {}, fetch, run);
  assert.deepEqual(await provider.structured({ ...request, model: "default" }), {
    value: { id: "done" },
  });
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes("--ephemeral"));
  assert.equal(args.includes("--model"), false);
  assert.ok(args.includes('model_reasoning_effort="low"'));
});

test("detects the first usable provider and switches only when the configured one is unusable", () => {
  assert.equal(detectProvider({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }), "anthropic");
  assert.equal(detectProvider({ OPENAI_API_KEY: "k", PATH: "" }), "openai");
  assert.equal(detectProvider({ PATH: "" }), undefined);

  const openai = defaultModelConfig("openai");
  assert.equal(usableModelConfig(openai, () => true).switchedTo, undefined);
  const switched = usableModelConfig(openai, (provider) => provider.type === "anthropic", {
    ANTHROPIC_API_KEY: "k",
  });
  assert.equal(switched.switchedTo, "anthropic");
  assert.equal(switched.config.profiles.balanced.roles.fast.model, "claude-sonnet-5-5");
  assert.equal(usableModelConfig(openai, () => false, { PATH: "" }).switchedTo, undefined);
  assert.equal(presetProfiles("claude").economy.roles.fast.model, "haiku");
});
