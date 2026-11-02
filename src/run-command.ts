import type { RunBudget, RunMode } from "./core/contracts.ts";

export interface RunCommand {
  mode: RunMode;
  budget?: RunBudget;
  task: string;
}

export function parseRunCommand(args: readonly string[]): RunCommand {
  let mode: RunMode = "independent";
  const budget: RunBudget = {};
  let index = 0;
  while (args[index]?.startsWith("--")) {
    const argument = args[index] as string;
    const [flag, inline] = argument.split("=", 2);
    const value = inline ?? args[index + 1];
    if (flag === "--mode") mode = parseRunMode(value);
    else if (flag === "--max-model-calls") budget.maxModelCalls = parseLimit(flag, value);
    else if (flag === "--max-actions") budget.maxActions = parseLimit(flag, value);
    else throw new Error(`unknown run option: ${flag}`);
    index += inline === undefined ? 2 : 1;
  }
  const task = args.slice(index).join(" ").trim();
  if (!task) throw new Error("run requires a task");
  return { mode, ...(Object.keys(budget).length > 0 ? { budget } : {}), task };
}

function parseLimit(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
    throw new Error(`${flag} must be an integer from 1 to 10000`);
  }
  return parsed;
}

export function parseRunMode(value: string | undefined): RunMode {
  if (value !== "independent" && value !== "broadcast" && value !== "coordinated") {
    throw new Error("mode must be independent, broadcast, or coordinated");
  }
  return value;
}
