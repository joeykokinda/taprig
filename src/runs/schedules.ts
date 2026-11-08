import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { RunMode } from "../core/contracts.ts";

export interface Schedule {
  id: string;
  task: string;
  mode: RunMode;
  /** Repeat interval in minutes; exclusive with `at`. */
  everyMinutes?: number;
  /** Local wall-clock time "HH:MM" to fire once a day; exclusive with `everyMinutes`. */
  at?: string;
  createdAt: string;
  lastFiredAt?: string;
}

export type ScheduleInput = Pick<Schedule, "task" | "mode" | "everyMinutes" | "at">;

function validate(input: ScheduleInput): ScheduleInput {
  if (typeof input.task !== "string" || !input.task.trim() || input.task.length > 10_000) {
    throw new Error("schedule task must be 1 to 10000 characters");
  }
  if (!["independent", "broadcast", "coordinated"].includes(input.mode)) {
    throw new Error("schedule mode is invalid");
  }
  const hasEvery = input.everyMinutes !== undefined;
  const hasAt = input.at !== undefined;
  if (hasEvery === hasAt) throw new Error("schedule needs exactly one of everyMinutes or at");
  if (hasEvery && (!Number.isSafeInteger(input.everyMinutes) || (input.everyMinutes ?? 0) < 1)) {
    throw new Error("everyMinutes must be a positive integer");
  }
  if (hasAt && !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(input.at ?? "")) {
    throw new Error("at must be HH:MM");
  }
  return input;
}

/** "every 30m", "every 2h", "daily at 08:00" as a human types it. */
export function parseCadence(words: readonly string[]): Pick<Schedule, "everyMinutes" | "at"> {
  const text = words.join(" ").trim().toLowerCase();
  const every = /^(?:every\s+)?(\d+)\s*(m|min|minutes?|h|hours?)$/u.exec(text);
  if (every?.[1]) {
    const amount = Number(every[1]);
    return { everyMinutes: every[2]?.startsWith("h") ? amount * 60 : amount };
  }
  const at = /^(?:daily\s+)?(?:at\s+)?(\d{1,2}:\d{2})$/u.exec(text);
  if (at?.[1]) return { at: at[1].padStart(5, "0") };
  throw new Error('cadence must look like "every 30m", "every 2h", or "daily at 08:00"');
}

function localClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Schedules live in one JSON file next to the database. The daemon calls `due()` on its poll
 * tick and creates a run for each schedule that is ready.
 * ponytail: minute cadence and one daily time only; a cron parser can replace parseCadence later.
 */
export class ScheduleService {
  readonly #path: string;
  #schedules: Schedule[];
  readonly #now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#path = path;
    this.#now = now;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      this.#schedules = Array.isArray(parsed) ? (parsed as Schedule[]) : [];
    } catch {
      this.#schedules = [];
    }
  }

  list(): readonly Schedule[] {
    return this.#schedules.map((schedule) => ({ ...schedule }));
  }

  add(input: ScheduleInput): Schedule {
    const valid = validate(input);
    const schedule: Schedule = {
      id: randomUUID(),
      task: valid.task.trim(),
      mode: valid.mode,
      ...(valid.everyMinutes !== undefined ? { everyMinutes: valid.everyMinutes } : {}),
      ...(valid.at !== undefined ? { at: valid.at } : {}),
      createdAt: this.#now().toISOString(),
    };
    this.#schedules.push(schedule);
    this.#save();
    return { ...schedule };
  }

  remove(id: string): boolean {
    const before = this.#schedules.length;
    this.#schedules = this.#schedules.filter((schedule) => schedule.id !== id);
    if (this.#schedules.length === before) return false;
    this.#save();
    return true;
  }

  /** Schedules ready to fire now; each is marked fired so one tick creates one run. */
  due(): Schedule[] {
    const now = this.#now();
    const ready = this.#schedules.filter((schedule) => {
      const last = schedule.lastFiredAt ? new Date(schedule.lastFiredAt) : undefined;
      if (schedule.everyMinutes !== undefined) {
        return !last || now.getTime() - last.getTime() >= schedule.everyMinutes * 60_000;
      }
      if (schedule.at === undefined) return false;
      const firedToday = last !== undefined && last.toDateString() === now.toDateString();
      return !firedToday && localClock(now) >= schedule.at;
    });
    if (ready.length === 0) return [];
    for (const schedule of ready) schedule.lastFiredAt = now.toISOString();
    this.#save();
    return ready.map((schedule) => ({ ...schedule }));
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#schedules, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
