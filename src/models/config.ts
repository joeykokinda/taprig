import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { dataDirectory } from "../paths.ts";

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

export interface ModelConfig {
  selectedProfile: ModelProfileName;
  providers: Record<string, OpenAiProviderConfig>;
  profiles: Record<ModelProfileName, ModelProfile>;
}

const target = (
  model: string,
  reasoningEffort: NonNullable<ModelTarget["reasoningEffort"]>,
): ModelTarget => ({ provider: "openai", model, reasoningEffort });

export function defaultModelConfig(): ModelConfig {
  const luna = target("gpt-6-luna", "low");
  const sol = target("gpt-6.1-sol", "medium");
  const astra = target("gpt-6-astra", "high");
  return {
    selectedProfile: "balanced",
    providers: {
      openai: { type: "openai", apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
    },
    profiles: {
      economy: {
        roles: { fast: luna, strong: luna, vision: luna },
        maxStrongCalls: 0,
        maxVisionCalls: 0,
      },
      balanced: {
        roles: { fast: luna, strong: sol, vision: target("gpt-6.1-terra", "medium") },
        maxStrongCalls: 3,
        maxVisionCalls: 3,
      },
      best: {
        roles: { fast: astra, strong: astra, vision: astra },
        maxStrongCalls: 20,
        maxVisionCalls: 20,
      },
    },
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
    if (!name || provider.type !== "openai" || !provider.apiKeyEnv || !provider.baseUrl) {
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

export function loadOrCreateModelConfig(path = modelConfigPath()): ModelConfig {
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    return validate(JSON.parse(readFileSync(path, "utf8")) as ModelConfig);
  }
  const config = defaultModelConfig();
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
