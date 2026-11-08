import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AppNotes } from "./model-decider.ts";

const maxNotes = 30;

/**
 * One small text file per app with UI facts earlier runs learned on this phone. Plain text so the
 * owner can read or delete it; never task data.
 * ponytail: shared across phones in one data dir; key by serial if rigs mix very different devices.
 */
export class FileAppNotes implements AppNotes {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  #path(packageName: string): string {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/u.test(packageName)) {
      throw new Error("invalid Android package name");
    }
    return join(this.#directory, `${packageName}.txt`);
  }

  async read(packageName: string): Promise<readonly string[]> {
    const text = await readFile(this.#path(packageName), "utf8").catch(() => "");
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async append(packageName: string, note: string): Promise<void> {
    const line = note.replace(/\s+/gu, " ").trim().slice(0, 200);
    if (!line) return;
    const existing = await this.read(packageName);
    if (existing.some((candidate) => candidate.toLowerCase() === line.toLowerCase())) return;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await writeFile(
      this.#path(packageName),
      `${[...existing, line].slice(-maxNotes).join("\n")}\n`,
      {
        mode: 0o600,
      },
    );
  }
}
