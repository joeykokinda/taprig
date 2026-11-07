import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";

import type { ProviderConfig } from "./config.ts";
import {
  OpenAiResponsesProvider,
  type StructuredModelRequest,
  type StructuredModelResponse,
} from "./openai.ts";

export interface StructuredModelProvider {
  structured(request: StructuredModelRequest): Promise<StructuredModelResponse>;
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options: { input: string; cwd: string; timeoutMs: number; environment: NodeJS.ProcessEnv },
) => Promise<string>;

export const runCommand: RunCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.environment,
        timeout: options.timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} failed: ${(stderr || error.message).trim().slice(-500)}`));
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(options.input);
  });

export function findExecutable(
  command: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const candidates = isAbsolute(command)
    ? [command]
    : (environment.PATH ?? "").split(delimiter).map((directory) => join(directory, command));
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** Whether the daemon can call this provider without further setup. */
export function providerReady(
  config: ProviderConfig,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (config.type === "openai" || config.type === "anthropic") {
    return Boolean(environment[config.apiKeyEnv]);
  }
  return findExecutable(config.command, environment) !== undefined;
}

export function providerRequirement(config: ProviderConfig): string {
  return config.type === "openai" || config.type === "anthropic"
    ? `set ${config.apiKeyEnv}`
    : `install and sign in to ${config.command}`;
}

// Structured outputs reject length and count constraints; parsers validate decisions afterwards.
const unsupportedKeywords = new Set(["minLength", "maxLength", "minItems", "maxItems"]);
function portableSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(portableSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !unsupportedKeywords.has(key))
      .map(([key, entry]) => [key, portableSchema(entry)]),
  );
}

class AnthropicMessagesProvider implements StructuredModelProvider {
  readonly #apiKeyEnv: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #fetch: typeof fetch;

  constructor(apiKeyEnv: string, environment: NodeJS.ProcessEnv, request: typeof fetch) {
    this.#apiKeyEnv = apiKeyEnv;
    this.#environment = environment;
    this.#fetch = request;
  }

  async structured(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    const apiKey = this.#environment[this.#apiKeyEnv];
    if (!apiKey) throw new Error(`${this.#apiKeyEnv} is not configured`);
    const client = new Anthropic({ apiKey, fetch: this.#fetch, timeout: 120_000 });
    // Haiku 4.5 rejects effort; refusal fallbacks are offered on the current Opus and Sonnet.
    const supportsEffort = !request.model.startsWith("claude-haiku-4");
    const fallback = /^claude-(opus-5-5|sonnet-5-5|opus-5|fable-5-1)$/u.test(request.model);
    const response = await client.beta.messages.create({
      model: request.model,
      max_tokens: 16_000,
      system: request.system,
      messages: [{ role: "user", content: request.input }],
      output_config: {
        format: { type: "json_schema", schema: portableSchema(request.schema) as never },
        ...(supportsEffort && request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
      },
      ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
    });
    if (response.stop_reason === "refusal") throw new Error("Claude declined this decision");
    if (response.stop_reason === "max_tokens") throw new Error("Claude decision was truncated");
    const text = response.content.find((block) => block.type === "text")?.text;
    if (!text) throw new Error("Claude response contained no structured output");
    return {
      value: JSON.parse(text),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

// Subscription CLIs run with no tools in an empty directory: phone screens are untrusted input.
class ClaudeCliProvider implements StructuredModelProvider {
  readonly #command: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #run: RunCommand;

  constructor(command: string, environment: NodeJS.ProcessEnv, run: RunCommand) {
    this.#command = command;
    this.#environment = environment;
    this.#run = run;
  }

  async structured(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    const directory = await mkdtemp(join(tmpdir(), "taprig-claude-"));
    try {
      const stdout = await this.#run(
        this.#command,
        [
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(portableSchema(request.schema)),
          "--tools",
          "",
          "--no-session-persistence",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--system-prompt",
          request.system,
          ...(request.model === "default" ? [] : ["--model", request.model]),
        ],
        {
          input: request.input,
          cwd: directory,
          timeoutMs: 180_000,
          environment: this.#environment,
        },
      );
      const result = JSON.parse(stdout) as {
        is_error?: boolean;
        result?: string;
        structured_output?: unknown;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (result.is_error || result.structured_output === undefined) {
        throw new Error(
          `claude returned no structured output: ${String(result.result).slice(0, 300)}`,
        );
      }
      return {
        value: result.structured_output,
        ...(result.usage?.input_tokens !== undefined
          ? { inputTokens: result.usage.input_tokens }
          : {}),
        ...(result.usage?.output_tokens !== undefined
          ? { outputTokens: result.usage.output_tokens }
          : {}),
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

class CodexCliProvider implements StructuredModelProvider {
  readonly #command: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #run: RunCommand;

  constructor(command: string, environment: NodeJS.ProcessEnv, run: RunCommand) {
    this.#command = command;
    this.#environment = environment;
    this.#run = run;
  }

  async structured(request: StructuredModelRequest): Promise<StructuredModelResponse> {
    const directory = await mkdtemp(join(tmpdir(), "taprig-codex-"));
    try {
      const schemaPath = join(directory, "schema.json");
      const outputPath = join(directory, "output.json");
      await writeFile(schemaPath, JSON.stringify(portableSchema(request.schema)));
      await this.#run(
        this.#command,
        [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--color",
          "never",
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...(request.model === "default" ? [] : ["--model", request.model]),
          ...(request.reasoningEffort
            ? ["-c", `model_reasoning_effort="${request.reasoningEffort}"`]
            : []),
          "-",
        ],
        {
          input: `${request.system}\n\nRespond only with the JSON object. Do not run commands.\n\n${request.input}`,
          cwd: directory,
          timeoutMs: 300_000,
          environment: this.#environment,
        },
      );
      return { value: JSON.parse(await readFile(outputPath, "utf8")) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

export function createStructuredProvider(
  config: ProviderConfig,
  environment: NodeJS.ProcessEnv = process.env,
  request: typeof fetch = fetch,
  run: RunCommand = runCommand,
): StructuredModelProvider {
  if (config.type === "openai") return new OpenAiResponsesProvider(config, environment, request);
  if (config.type === "anthropic") {
    return new AnthropicMessagesProvider(config.apiKeyEnv, environment, request);
  }
  if (config.type === "claude-cli") return new ClaudeCliProvider(config.command, environment, run);
  return new CodexCliProvider(config.command, environment, run);
}
