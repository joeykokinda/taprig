import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PhoneNotification } from "../android/notifications.ts";

export interface Trigger {
  id: string;
  /** Case-insensitive regular expression tested against "package title text". */
  match: string;
  task: string;
  createdAt: string;
  lastFiredAt?: string;
}

/**
 * Notification-triggered runs: "when Mom texts, read it to me". The daemon reads each ready
 * phone's shade on its poll and fires a trigger for every new notification that matches.
 * ponytail: dedupe by postedAt per phone; notifications without a timestamp never trigger.
 */
export class TriggerService {
  readonly #path: string;
  #triggers: Trigger[];
  readonly #seen = new Map<string, string>();
  readonly #now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.#path = path;
    this.#now = now;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      this.#triggers = Array.isArray(parsed) ? (parsed as Trigger[]) : [];
    } catch {
      this.#triggers = [];
    }
  }

  list(): readonly Trigger[] {
    return this.#triggers.map((trigger) => ({ ...trigger }));
  }

  add(match: string, task: string): Trigger {
    if (typeof match !== "string" || !match.trim() || match.length > 500) {
      throw new Error("trigger match must be 1 to 500 characters");
    }
    new RegExp(match, "iu");
    if (typeof task !== "string" || !task.trim() || task.length > 10_000) {
      throw new Error("trigger task must be 1 to 10000 characters");
    }
    const trigger: Trigger = {
      id: randomUUID(),
      match: match.trim(),
      task: task.trim(),
      createdAt: this.#now().toISOString(),
    };
    this.#triggers.push(trigger);
    this.#save();
    return { ...trigger };
  }

  remove(id: string): boolean {
    const before = this.#triggers.length;
    this.#triggers = this.#triggers.filter((trigger) => trigger.id !== id);
    if (this.#triggers.length === before) return false;
    this.#save();
    return true;
  }

  /**
   * Tasks to start for notifications newer than the last poll of this phone. The first poll only
   * records what is already there, so a restart never replays old notifications.
   */
  fire(deviceId: string, notifications: readonly PhoneNotification[]): string[] {
    const newest = notifications
      .map((item) => item.postedAt ?? "")
      .filter(Boolean)
      .sort()
      .at(-1);
    const previous = this.#seen.get(deviceId);
    if (newest) this.#seen.set(deviceId, newest);
    if (previous === undefined || this.#triggers.length === 0) return [];
    const fresh = notifications.filter((item) => item.postedAt && item.postedAt > previous);
    const tasks: string[] = [];
    for (const item of fresh) {
      const haystack = `${item.package} ${item.title} ${item.text}`;
      for (const trigger of this.#triggers) {
        if (!new RegExp(trigger.match, "iu").test(haystack)) continue;
        trigger.lastFiredAt = this.#now().toISOString();
        tasks.push(
          `${trigger.task}\n\nTriggered by this notification from ${item.package}: "${item.title}" - "${item.text}"`,
        );
      }
    }
    if (tasks.length > 0) this.#save();
    return tasks;
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#triggers, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
