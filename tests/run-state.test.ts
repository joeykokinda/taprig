import assert from "node:assert/strict";
import test from "node:test";

import type { RunState, TapRigError } from "../src/core/contracts.ts";
import { applyRunEvent } from "../src/core/run-state.ts";

const created: RunState = {
  id: "run-1",
  mode: "independent",
  task: "Open Settings",
  status: "created",
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
};

test("a run follows valid lifecycle transitions", () => {
  let state = applyRunEvent(undefined, { type: "run.created", run: created });
  state = applyRunEvent(state, { type: "run.started", at: "2026-10-28T00:00:01.000Z" });
  state = applyRunEvent(state, { type: "run.paused", at: "2026-10-28T00:00:02.000Z" });
  state = applyRunEvent(state, { type: "run.resumed", at: "2026-10-28T00:00:03.000Z" });
  state = applyRunEvent(state, { type: "run.completed", at: "2026-10-28T00:00:04.000Z" });

  assert.equal(state.status, "completed");
  assert.equal(state.updatedAt, "2026-10-28T00:00:04.000Z");
});

test("a terminal run cannot restart", () => {
  const completed = { ...created, status: "completed" } satisfies RunState;
  assert.throws(
    () => applyRunEvent(completed, { type: "run.started", at: "2026-10-28T00:00:01.000Z" }),
    /cannot transition/,
  );
});

test("a failed run preserves its typed error", () => {
  const error: TapRigError = {
    code: "verification-failed",
    message: "Settings did not open",
    retryable: true,
  };
  const running = { ...created, status: "running" } satisfies RunState;
  const failed = applyRunEvent(running, {
    type: "run.failed",
    at: "2026-10-28T00:00:01.000Z",
    error,
  });

  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.error, error);
});
