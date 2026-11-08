import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ApprovalPolicy = "autonomous" | "explicit";
/** always: a screenshot with every decision; auto: only on thin screens or after a miss. */
export type VisionPolicy = "always" | "auto";

export interface TapRigSettings {
  approvalPolicy: ApprovalPolicy;
  retainScreenshotsByDefault: boolean;
  vision: VisionPolicy;
  /** Record each run with the phone's screenrecord and keep it as a video artifact. */
  recordVideo: boolean;
}

const defaults: TapRigSettings = {
  approvalPolicy: "explicit",
  retainScreenshotsByDefault: false,
  vision: "always",
  recordVideo: true,
};

function validate(value: unknown): TapRigSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("settings must be an object");
  }
  const settings = value as Record<string, unknown>;
  if (Object.keys(settings).some((key) => !(key in defaults))) {
    throw new Error("settings contain an unknown field");
  }
  if (settings.approvalPolicy !== "autonomous" && settings.approvalPolicy !== "explicit") {
    throw new Error("approvalPolicy must be autonomous or explicit");
  }
  if (typeof settings.retainScreenshotsByDefault !== "boolean") {
    throw new Error("retainScreenshotsByDefault must be boolean");
  }
  const vision = settings.vision ?? defaults.vision;
  if (vision !== "always" && vision !== "auto") throw new Error("vision must be always or auto");
  const recordVideo = settings.recordVideo ?? defaults.recordVideo;
  if (typeof recordVideo !== "boolean") throw new Error("recordVideo must be boolean");
  return {
    approvalPolicy: settings.approvalPolicy,
    retainScreenshotsByDefault: settings.retainScreenshotsByDefault,
    vision,
    recordVideo,
  };
}

export class SettingsService {
  readonly #path: string;
  #settings: TapRigSettings;

  constructor(path: string) {
    if (!path) throw new Error("settings path is required");
    this.#path = path;
    if (existsSync(path)) {
      chmodSync(path, 0o600);
      this.#settings = validate(JSON.parse(readFileSync(path, "utf8")));
    } else {
      this.#settings = { ...defaults };
      this.#save();
    }
  }

  get(): TapRigSettings {
    return { ...this.#settings };
  }

  update(patch: unknown): TapRigSettings {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new Error("settings patch must be an object");
    }
    this.#settings = validate({ ...this.#settings, ...(patch as object) });
    this.#save();
    return this.get();
  }

  #save(): void {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, this.#path);
    chmodSync(this.#path, 0o600);
  }
}
