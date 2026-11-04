import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactService } from "../src/artifacts/service.ts";
import { TapRigStore } from "../src/persistence/store.ts";
import { RunService } from "../src/runs/service.ts";

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("test-image"),
]);

test("retains, inventories, reads, and exports a private run screenshot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-artifacts-"));
  context.after(() => rm(directory, { recursive: true }));
  const database = join(directory, "taprig.db");
  let store = new TapRigStore(database);
  context.after(() => store.close());
  const runs = new RunService(
    store,
    () => "2026-11-04T12:00:00.000Z",
    () => "run-1",
  );
  const run = runs.create("Open Settings");
  runs.record(run.id, { type: "run.started", at: "2026-11-04T12:00:01.000Z" });
  const artifacts = new ArtifactService(join(directory, "artifacts"), store, () => "artifact-1");

  const artifact = await artifacts.screenshot(run.id, "phone-1", async () => png);
  assert.equal(artifact.relativePath, join(run.id, "artifact-1.png"));
  assert.deepEqual(await artifacts.read(run.id, artifact.id), png);
  assert.equal(
    (await stat(join(directory, "artifacts", artifact.relativePath))).mode & 0o777,
    0o600,
  );
  assert.equal(artifacts.list(run.id).length, 1);
  const payloads = await artifacts.payloads(run.id);
  assert.equal(payloads[0]?.data, png.toString("base64"));
  assert.equal(payloads[0]?.relativePath, "artifact-1.png");
  assert.equal(
    runs.events(run.id).some(({ event }) => event.type === "artifact.created"),
    true,
  );
  store.close();
  store = new TapRigStore(database);
  const restored = new ArtifactService(join(directory, "artifacts"), store);
  assert.equal(restored.list(run.id)[0]?.id, artifact.id);
  assert.deepEqual(await restored.read(run.id, artifact.id), png);
});
