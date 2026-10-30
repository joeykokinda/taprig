import { resolveElement } from "../android/semantic.ts";
import type { Action, DeviceAdapter, Observation, Selector } from "../core/contracts.ts";
import type { ScriptRunResult, TapRigScript } from "./contracts.ts";

function substitute(value: string, parameters: Readonly<Record<string, string>>): string {
  return value.replace(/\{\{([a-z][a-z0-9_-]{0,63})\}\}/gu, (_match, name: string) => {
    const replacement = parameters[name];
    if (replacement === undefined) throw new Error(`missing script parameter ${name}`);
    return replacement;
  });
}

function selector(value: Selector, parameters: Readonly<Record<string, string>>): Selector {
  if ("elementId" in value) return { elementId: substitute(value.elementId, parameters) };
  if ("resourceId" in value) return { resourceId: substitute(value.resourceId, parameters) };
  if ("description" in value) return { description: substitute(value.description, parameters) };
  return {
    text: substitute(value.text, parameters),
    ...(value.role ? { role: substitute(value.role, parameters) } : {}),
  };
}

function action(value: Action, parameters: Readonly<Record<string, string>>): Action {
  switch (value.type) {
    case "app.launch":
      return { ...value, packageName: substitute(value.packageName, parameters) };
    case "element.tap":
    case "element.longTap":
      return { ...value, target: selector(value.target, parameters) };
    case "element.text":
      return {
        ...value,
        target: selector(value.target, parameters),
        value: substitute(value.value, parameters),
      };
    default:
      return value;
  }
}

function inputs(
  script: TapRigScript,
  provided: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const parameter of script.parameters) {
    const value = provided[parameter.name] ?? parameter.default;
    if (parameter.required && value === undefined) {
      throw new Error(`missing required script parameter ${parameter.name}`);
    }
    if (value !== undefined) resolved[parameter.name] = value;
  }
  const declared = new Set(script.parameters.map((parameter) => parameter.name));
  for (const name of Object.keys(provided)) {
    if (!declared.has(name)) throw new Error(`unknown script parameter ${name}`);
  }
  return resolved;
}

function checkpointSatisfied(
  observation: Observation,
  checkpoint: NonNullable<TapRigScript["steps"][number]["checkpoint"]>,
  parameters: Readonly<Record<string, string>>,
): boolean {
  if (
    checkpoint.foregroundPackage &&
    observation.foregroundPackage !== substitute(checkpoint.foregroundPackage, parameters)
  ) {
    return false;
  }
  if (checkpoint.selector) {
    try {
      resolveElement(observation, selector(checkpoint.selector, parameters));
    } catch {
      return false;
    }
  }
  return true;
}

export async function runScript(
  script: TapRigScript,
  provided: Readonly<Record<string, string>>,
  device: DeviceAdapter,
  deviceId: string,
  requestPrefix: string = randomUUID(),
): Promise<ScriptRunResult> {
  const parameters = inputs(script, provided);
  let completedSteps = 0;
  for (const step of script.steps) {
    const observation = await device.observe(deviceId);
    const result = await device.execute({
      requestId: `${requestPrefix}:${step.id}`,
      deviceId,
      observationGeneration: observation.generation,
      steps: [{ id: step.id, action: action(step.action, parameters) }],
    });
    const failed = result.steps[0];
    if (failed?.status !== "verified") {
      return {
        status: "recovery-needed",
        completedSteps,
        stepId: step.id,
        reason: failed?.error?.message ?? "script action was not verified",
      };
    }
    if (step.checkpoint) {
      const after = await device.observe(deviceId);
      if (!checkpointSatisfied(after, step.checkpoint, parameters)) {
        return {
          status: "recovery-needed",
          completedSteps,
          stepId: step.id,
          reason: "script checkpoint did not match fresh device state",
        };
      }
    }
    completedSteps += 1;
  }
  return { status: "completed", completedSteps };
}

import { randomUUID } from "node:crypto";
