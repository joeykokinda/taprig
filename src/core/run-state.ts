import type { RunEvent, RunState, RunStatus } from "./contracts.ts";

const allowedTransitions: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  created: ["running", "stopped"],
  running: ["paused", "waiting-for-user", "completed", "failed", "stopped"],
  paused: ["running", "stopped"],
  "waiting-for-user": ["running", "failed", "stopped"],
  completed: [],
  failed: [],
  stopped: [],
};

export function applyRunEvent(current: RunState | undefined, event: RunEvent): RunState {
  if (event.type === "run.created") {
    if (current) throw new Error(`run ${current.id} already exists`);
    if (event.run.status !== "created") throw new Error("new runs must have created status");
    return event.run;
  }

  if (!current) throw new Error(`${event.type} requires an existing run`);

  const nextStatus = statusFor(event);
  if (!allowedTransitions[current.status].includes(nextStatus)) {
    throw new Error(`cannot transition run ${current.id} from ${current.status} to ${nextStatus}`);
  }

  const next: RunState = {
    ...current,
    status: nextStatus,
    updatedAt: event.at,
  };

  if (event.type === "run.failed") return { ...next, error: event.error };
  return next;
}

function statusFor(event: Exclude<RunEvent, { type: "run.created" }>): RunStatus {
  switch (event.type) {
    case "run.started":
    case "run.resumed":
      return "running";
    case "run.paused":
      return "paused";
    case "run.waitingForUser":
      return "waiting-for-user";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "run.stopped":
      return "stopped";
  }
}
