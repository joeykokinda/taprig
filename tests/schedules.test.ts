import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseCadence, ScheduleService } from "../src/runs/schedules.ts";

test("parses human cadences", () => {
  assert.deepEqual(parseCadence(["every 30m"]), { everyMinutes: 30 });
  assert.deepEqual(parseCadence(["every", "2h"]), { everyMinutes: 120 });
  assert.deepEqual(parseCadence(["daily at 8:05"]), { at: "08:05" });
  assert.throws(() => parseCadence(["whenever"]), /cadence/u);
});

test("fires interval schedules when due and daily schedules once per day", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-schedules-"));
  context.after(() => rm(directory, { recursive: true }));
  let clock = new Date(2026, 10, 8, 7, 59);
  const path = join(directory, "schedules.json");
  let schedules = new ScheduleService(path, () => clock);
  schedules.add({ task: "Check notifications", mode: "independent", everyMinutes: 30 });
  schedules.add({ task: "Morning summary", mode: "independent", at: "08:00" });
  assert.deepEqual(
    schedules.due().map(({ task }) => task),
    ["Check notifications"],
    "an interval fires immediately, a daily time waits",
  );
  clock = new Date(2026, 10, 8, 8, 0);
  assert.deepEqual(
    schedules.due().map(({ task }) => task),
    ["Morning summary"],
  );
  clock = new Date(2026, 10, 8, 8, 20);
  assert.deepEqual(schedules.due(), []);
  clock = new Date(2026, 10, 8, 8, 30);
  schedules = new ScheduleService(path, () => clock);
  assert.deepEqual(
    schedules.due().map(({ task }) => task),
    ["Check notifications"],
    "state survives a restart",
  );
  assert.throws(
    () => schedules.add({ task: "x", mode: "independent", everyMinutes: 5, at: "09:00" }),
    /exactly one/u,
  );
});
