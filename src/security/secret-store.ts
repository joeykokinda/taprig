import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const secretTokenPattern = /\{\{secret:([A-Za-z0-9_.-]{1,64})\}\}/gu;

/**
 * Named secrets a task can reference as {{secret:NAME}}. The model only ever sees the token; the
 * run worker swaps in the value right before it reaches the phone and redacts it from traces.
 * Stored as a 0600 JSON file in the data directory, like the unlock PIN in the daemon environment.
 * ponytail: plaintext at rest behind file permissions; an OS keychain can replace #save later.
 */
export class SecretStore {
  readonly #path: string;
  #values: Record<string, string>;

  constructor(path: string) {
    this.#path = path;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      this.#values =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {};
    } catch {
      this.#values = {};
    }
  }

  names(): string[] {
    return Object.keys(this.#values).sort();
  }

  get(name: string): string | undefined {
    return this.#values[name];
  }

  set(name: string, value: string): void {
    if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(name)) {
      throw new Error("secret names use letters, digits, dot, dash, underscore (1-64)");
    }
    if (!value || value.length > 10_000)
      throw new Error("secret value must be 1 to 10000 characters");
    this.#values[name] = value;
    this.#save();
  }

  remove(name: string): boolean {
    if (!(name in this.#values)) return false;
    delete this.#values[name];
    this.#save();
    return true;
  }

  /** Values for every token in `text`; unknown names throw so a typo never types the token. */
  resolve(text: string): string {
    return text.replace(secretTokenPattern, (_match, name: string) => {
      const value = this.#values[name];
      if (value === undefined)
        throw new Error(`unknown secret "${name}"; add it with taprig secret set ${name}`);
      return value;
    });
  }

  /** Secret values referenced by `text`, for redaction. */
  referenced(text: string): string[] {
    return [...text.matchAll(secretTokenPattern)].flatMap(([, name]) => {
      const value = name ? this.#values[name] : undefined;
      return value ? [value] : [];
    });
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#values, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#path);
  }
}
