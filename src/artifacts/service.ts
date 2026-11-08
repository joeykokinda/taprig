import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

import { captureScreenshot, type ScreenshotRunner } from "../android/screenshot.ts";
import type { StoredArtifact, TapRigStore } from "../persistence/store.ts";

const maximumExportBytes = 100 * 1024 * 1024;

export class ArtifactService {
  readonly #root: string;
  readonly #store: TapRigStore;
  readonly #id: () => string;

  constructor(root: string, store: TapRigStore, id: () => string = randomUUID) {
    if (!root) throw new Error("artifact root is required");
    this.#root = resolve(root);
    this.#store = store;
    this.#id = id;
  }

  async screenshot(
    runId: string,
    deviceId: string,
    run?: ScreenshotRunner,
    now = () => new Date().toISOString(),
  ): Promise<StoredArtifact> {
    if (!this.#store.getRun(runId)) throw new Error(`run ${runId} not found`);
    const id = this.#id();
    const directory = join(this.#root, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.png`);
    const captured = run
      ? await captureScreenshot(deviceId, path, run, now)
      : await captureScreenshot(deviceId, path, undefined, now);
    const artifact: StoredArtifact = {
      id,
      runId,
      deviceId,
      kind: "screenshot",
      name: `${deviceId} terminal screenshot`,
      mimeType: "image/png",
      relativePath: relative(this.#root, captured.path),
      bytes: captured.bytes,
      createdAt: captured.capturedAt,
    };
    this.#store.saveArtifact(artifact);
    this.#store.recordRunEvent(this.#store.getRun(runId), {
      type: "artifact.created",
      at: artifact.createdAt,
      artifactId: artifact.id,
      kind: artifact.kind,
      deviceId,
    });
    return artifact;
  }

  /** Reserves the path a run recording should be pulled to; call `video` once it is there. */
  async videoPath(runId: string): Promise<{ id: string; path: string }> {
    const id = this.#id();
    const directory = join(this.#root, runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return { id, path: join(directory, `${id}.mp4`) };
  }

  video(
    runId: string,
    deviceId: string,
    reserved: { id: string; path: string },
    bytes: number,
    now = () => new Date().toISOString(),
  ): StoredArtifact {
    if (!this.#store.getRun(runId)) throw new Error(`run ${runId} not found`);
    const artifact: StoredArtifact = {
      id: reserved.id,
      runId,
      deviceId,
      kind: "video",
      name: `${deviceId} run recording`,
      mimeType: "video/mp4",
      relativePath: relative(this.#root, reserved.path),
      bytes,
      createdAt: now(),
    };
    this.#store.saveArtifact(artifact);
    this.#store.recordRunEvent(this.#store.getRun(runId), {
      type: "artifact.created",
      at: artifact.createdAt,
      artifactId: artifact.id,
      kind: artifact.kind,
      deviceId,
    });
    return artifact;
  }

  list(runId: string): StoredArtifact[] {
    if (!this.#store.getRun(runId)) throw new Error(`run ${runId} not found`);
    return this.#store.listArtifacts(runId);
  }

  async read(runId: string, artifactId: string): Promise<Buffer> {
    const artifact = this.#store.getArtifact(runId, artifactId);
    if (!artifact) throw new Error("artifact not found");
    const path = this.#path(artifact.relativePath);
    const info = await stat(path);
    if (!info.isFile() || info.size !== artifact.bytes) throw new Error("artifact file is invalid");
    return readFile(path);
  }

  async payloads(runId: string): Promise<Array<StoredArtifact & { data: string }>> {
    const artifacts = this.list(runId);
    if (artifacts.reduce((total, artifact) => total + artifact.bytes, 0) > maximumExportBytes) {
      throw new Error("run artifacts exceed the 100 MiB export limit");
    }
    return Promise.all(
      artifacts.map(async (artifact) => ({
        ...artifact,
        relativePath: basename(artifact.relativePath),
        data: (await this.read(runId, artifact.id)).toString("base64"),
      })),
    );
  }

  #path(relativePath: string): string {
    const path = resolve(this.#root, relativePath);
    if (path !== this.#root && !path.startsWith(`${this.#root}${sep}`)) {
      throw new Error("artifact path escapes its private root");
    }
    return path;
  }
}
