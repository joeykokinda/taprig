import type { RunMode } from "./core/contracts.ts";

export interface RunCommand {
  mode: RunMode;
  task: string;
}

export function parseRunCommand(args: readonly string[]): RunCommand {
  let mode: RunMode = "independent";
  let taskParts = args;
  if (args[0] === "--mode") {
    mode = parseRunMode(args[1]);
    taskParts = args.slice(2);
  } else if (args[0]?.startsWith("--mode=")) {
    mode = parseRunMode(args[0].slice("--mode=".length));
    taskParts = args.slice(1);
  }
  const task = taskParts.join(" ").trim();
  if (!task) throw new Error("run requires a task");
  return { mode, task };
}

export function parseRunMode(value: string | undefined): RunMode {
  if (value !== "independent" && value !== "broadcast" && value !== "coordinated") {
    throw new Error("mode must be independent, broadcast, or coordinated");
  }
  return value;
}
