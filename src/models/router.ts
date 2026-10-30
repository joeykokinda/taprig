import type { ModelConfig, ModelProfileName, ModelRole, ModelTarget } from "./config.ts";

export interface ModelUsage {
  strongCalls: number;
  visionCalls: number;
}

export interface ModelRoute {
  profile: ModelProfileName;
  role: ModelRole;
  target: ModelTarget;
  reason: string;
}

export function routeModel(
  config: ModelConfig,
  role: ModelRole,
  usage: ModelUsage,
  profileName = config.selectedProfile,
): ModelRoute | undefined {
  const profile = config.profiles[profileName];
  if (role === "strong" && usage.strongCalls >= profile.maxStrongCalls) return undefined;
  if (role === "vision" && usage.visionCalls >= profile.maxVisionCalls) return undefined;
  return {
    profile: profileName,
    role,
    target: profile.roles[role],
    reason: role === "fast" ? "routine semantic decision" : `${role} escalation within budget`,
  };
}
