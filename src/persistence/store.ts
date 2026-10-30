import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DeviceActorState } from "../android/device-actor.ts";
import type { RunEvent, RunState } from "../core/contracts.ts";
import { applyRunEvent } from "../core/run-state.ts";

export interface StoredQuestion {
  id: string;
  runId: string;
  prompt: string;
  status: "open" | "answered" | "dismissed";
  createdAt: string;
}

export interface StoredCheckpoint {
  id: string;
  runId: string;
  deviceId: string;
  name: string;
  evidence: unknown;
  createdAt: string;
}

type JsonRow = { json: string };

export interface StoredRunEvent {
  sequence: number;
  event: RunEvent;
}

export class TapRigStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (!path) throw new Error("database path must not be empty");
    if (path !== ":memory:") {
      const directory = dirname(path);
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.#database.close();
  }

  saveDevice(device: DeviceActorState): void {
    this.#database
      .prepare(`
        INSERT INTO devices (id, json, observed_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json, observed_at = excluded.observed_at
      `)
      .run(device.id, JSON.stringify(device), device.observedAt);
  }

  getDevice(id: string): DeviceActorState | undefined {
    const row = this.#database.prepare("SELECT json FROM devices WHERE id = ?").get(id) as
      | JsonRow
      | undefined;
    return row ? (JSON.parse(row.json) as DeviceActorState) : undefined;
  }

  getRun(id: string): RunState | undefined {
    const row = this.#database.prepare("SELECT json FROM runs WHERE id = ?").get(id) as
      | JsonRow
      | undefined;
    return row ? (JSON.parse(row.json) as RunState) : undefined;
  }

  listRuns(limit = 100): RunState[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("run limit must be an integer from 1 to 1000");
    }
    const rows = this.#database
      .prepare("SELECT json FROM runs ORDER BY updated_at DESC, id ASC LIMIT ?")
      .all(limit) as unknown as JsonRow[];
    return rows.map((row) => JSON.parse(row.json) as RunState);
  }

  listRunEvents(runId: string, afterSequence = 0): StoredRunEvent[] {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("event sequence must be a non-negative integer");
    }
    const rows = this.#database
      .prepare(
        "SELECT sequence, json FROM run_events WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC",
      )
      .all(runId, afterSequence) as unknown as Array<{ sequence: number; json: string }>;
    return rows.map((row) => ({ sequence: row.sequence, event: JSON.parse(row.json) as RunEvent }));
  }

  recordRunEvent(current: RunState | undefined, event: RunEvent): RunState {
    const next = applyRunEvent(current, event);
    const occurredAt = event.type === "run.created" ? event.run.createdAt : event.at;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database
        .prepare(`
          INSERT INTO runs (id, json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
        `)
        .run(next.id, JSON.stringify(next), next.updatedAt);
      this.#database
        .prepare("INSERT INTO run_events (run_id, json, occurred_at) VALUES (?, ?, ?)")
        .run(next.id, JSON.stringify(event), occurredAt);
      this.#database.exec("COMMIT");
      return next;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  saveQuestion(question: StoredQuestion): void {
    this.#database
      .prepare(`
        INSERT INTO questions (id, run_id, json, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json
      `)
      .run(question.id, question.runId, JSON.stringify(question), question.createdAt);
  }

  saveCheckpoint(checkpoint: StoredCheckpoint): void {
    this.#database
      .prepare(`
        INSERT INTO checkpoints (id, run_id, json, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json
      `)
      .run(checkpoint.id, checkpoint.runId, JSON.stringify(checkpoint), checkpoint.createdAt);
  }

  getCheckpoint(runId: string, name: string): StoredCheckpoint | undefined {
    const rows = this.#database
      .prepare("SELECT json FROM checkpoints WHERE run_id = ? ORDER BY rowid DESC")
      .all(runId) as unknown as JsonRow[];
    return rows
      .map((row) => JSON.parse(row.json) as StoredCheckpoint)
      .find((item) => item.name === name);
  }

  eventCount(runId: string): number {
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM run_events WHERE run_id = ?")
      .get(runId) as { count: number };
    return row.count;
  }
}
