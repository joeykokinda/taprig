import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataDirectory } from "../paths.ts";
import { findExecutable } from "./providers.ts";

export type ModelProfileName = "economy" | "balanced" | "best";
export type ModelRole = "fast" | "strong" | "vision";

export interface ModelTarget {
  provider: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
}

export interface ModelProfile {
  roles: Record<ModelRole, ModelTarget>;
  maxStrongCalls: number;
  maxVisionCalls: number;
}

export interface OpenAiProviderConfig {
  type: "openai";
  apiKeyEnv: string;
  baseUrl: string;
}

export interface AnthropicProviderConfig {
  type: "anthropic";
  apiKeyEnv: string;
}

/** Signed-in Claude Code or Codex CLI, so subscriptions work without an API key. */
export interface CliProviderConfig {
  type: "claude-cli" | "codex-cli";
  command: string;
}

export type ProviderConfig = OpenAiProviderConfig | AnthropicProviderConfig | CliProviderConfig;
export type ProviderName = "openai" | "anthropic" | "claude" | "codex";

export interface ModelConfig {
  selectedProfile: ModelProfileName;
  providers: Record<string, ProviderConfig>;
  profiles: Record<ModelProfileName, ModelProfile>;
}

export const defaultProviders: Record<ProviderName, ProviderConfig> = {
  openai: { type: "openai", apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
  anthropic: { type: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" },
  claude: { type: "claude-cli", command: "claude" },
  codex: { type: "codex-cli", command: "codex" },
};

type Effort = NonNullable<ModelTarget["reasoningEffort"]>;
type Preset = Record<ModelProfileName, Record<ModelRole, [string, Effort]>>;

const presets: Record<ProviderName, Preset> = {
  openai: {
    economy: {
      fast: ["gpt-6-luna", "low"],
      strong: ["gpt-6-luna", "low"],
      vision: ["gpt-6-luna", "low"],
    },
    balanced: {
      fast: ["gpt-6-luna", "low"],
      strong: ["gpt-6.1-sol", "medium"],
      vision: ["gpt-6.1-terra", "medium"],
    },
    best: {
      fast: ["gpt-6-astra", "high"],
      strong: ["gpt-6-astra", "high"],
      vision: ["gpt-6-astra", "high"],
    },
  },
  anthropic: {
    economy: {
      fast: ["claude-haiku-4-5", "low"],
      strong: ["claude-haiku-4-5", "low"],
      vision: ["claude-haiku-4-5", "low"],
    },
    balanced: {
      fast: ["claude-sonnet-5-5", "low"],
      strong: ["claude-opus-5-5", "medium"],
      vision: ["claude-sonnet-5-5", "medium"],
    },
    best: {
      fast: ["claude-opus-5-5", "high"],
      strong: ["claude-opus-5-5", "high"],
      vision: ["claude-opus-5-5", "high"],
    },
  },
  claude: {
    economy: { fast: ["haiku", "low"], strong: ["haiku", "low"], vision: ["haiku", "low"] },
    balanced: { fast: ["sonnet", "low"], strong: ["opus", "medium"], vision: ["sonnet", "medium"] },
    best: { fast: ["opus", "high"], strong: ["opus", "high"], vision: ["opus", "high"] },
  },
  codex: {
    economy: { fast: ["default", "low"], strong: ["default", "low"], vision: ["default", "low"] },
    balanced: {
      fast: ["default", "low"],
      strong: ["default", "medium"],
      vision: ["default", "medium"],
    },
    best: { fast: ["default", "high"], strong: ["default", "high"], vision: ["default", "high"] },
  },
};

const budgets: Record<ModelProfileName, [number, number]> = {
  economy: [0, 0],
  balanced: [3, 3],
  best: [20, 20],
};

export function presetProfiles(provider: ProviderName): Record<ModelProfileName, ModelProfile> {
  const profile = (name: ModelProfileName): ModelProfile => {
    const roles = presets[provider][name];
    const role = (selected: ModelRole): ModelTarget => ({
      provider,
      model: roles[selected][0],
      reasoningEffort: roles[selected][1],
    });
    return {
      roles: { fast: role("fast"), strong: role("strong"), vision: role("vision") },
      maxStrongCalls: budgets[name][0],
      maxVisionCalls: budgets[name][1],
    };
  };
  return { economy: profile("economy"), balanced: profile("balanced"), best: profile("best") };
}

/** First provider that works on this machine: API keys first, then signed-in CLIs. */
export function detectProvider(
  environment: NodeJS.ProcessEnv = process.env,
): ProviderName | undefined {
  if (environment.ANTHROPIC_API_KEY) return "anthropic";
  if (environment.OPENAI_API_KEY) return "openai";
  if (findExecutable("claude", environment)) return "claude";
  if (findExecutable("codex", environment)) return "codex";
  return undefined;
}

export function defaultModelConfig(provider: ProviderName = "openai"): ModelConfig {
  return {
    selectedProfile: "balanced",
    providers: { ...defaultProviders },
    profiles: presetProfiles(provider),
  };
}

/**
 * Keeps the configured provider when it is usable; otherwise switches this daemon to whatever
 * provider is available here, so plugging in with only a signed-in CLI still works.
 */
export function usableModelConfig(
  config: ModelConfig,
  ready: (provider: ProviderConfig) => boolean,
  environment: NodeJS.ProcessEnv = process.env,
): { config: ModelConfig; switchedTo?: ProviderName } {
  const selected = config.profiles[config.selectedProfile].roles.fast.provider;
  const provider = config.providers[selected];
  if (provider && ready(provider)) return { config };
  const detected = detectProvider(environment);
  if (!detected || detected === selected) return { config };
  return {
    config: {
      ...config,
      providers: { ...defaultProviders, ...config.providers },
      profiles: presetProfiles(detected),
    },
    switchedTo: detected,
  };
}

export function modelConfigPath(): string {
  return join(dataDirectory(), "models.json");
}

function validate(config: ModelConfig): ModelConfig {
  if (!(["economy", "balanced", "best"] as const).includes(config.selectedProfile)) {
    throw new Error("invalid selected model profile");
  }
  for (const [name, provider] of Object.entries(config.providers)) {
    const valid =
      provider.type === "openai"
        ? Boolean(provider.apiKeyEnv && provider.baseUrl)
        : provider.type === "anthropic"
          ? Boolean(provider.apiKeyEnv)
          : (provider.type === "claude-cli" || provider.type === "codex-cli") &&
            Boolean(provider.command);
    if (!name || !valid) {
      throw new Error(`invalid model provider ${name}`);
    }
  }
  for (const name of ["economy", "balanced", "best"] as const) {
    const profile = config.profiles[name];
    if (!profile) throw new Error(`missing ${name} model profile`);
    for (const role of ["fast", "strong", "vision"] as const) {
      const selected = profile.roles[role];
      if (!selected?.model || !config.providers[selected.provider]) {
        throw new Error(`invalid ${name} ${role} model target`);
      }
    }
    if (
      !Number.isSafeInteger(profile.maxStrongCalls) ||
      profile.maxStrongCalls < 0 ||
      !Number.isSafeInteger(profile.maxVisionCalls) ||
      profile.maxVisionCalls < 0
    ) {
      throw new Error(`invalid ${name} model budgets`);
    }
  }
  return config;
}

export function loadOrCreateModelConfig(
  path = modelConfigPath(),
  environment: NodeJS.ProcessEnv = process.env,
): ModelConfig {
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    const config = JSON.parse(readFileSync(path, "utf8")) as ModelConfig;
    // Configs written before more providers existed still gain them.
    config.providers = { ...defaultProviders, ...config.providers };
    return validate(config);
  }
  const config = defaultModelConfig(detectProvider(environment));
  saveModelConfig(config, path);
  return config;
}

export function saveModelConfig(config: ModelConfig, path = modelConfigPath()): void {
  validate(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
