import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SettingsService } from "../src/settings.ts";

test("persists validated private owner settings atomically", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-settings-"));
  context.after(() => rm(directory, { recursive: true }));
  const path = join(directory, "settings.json");
  let settings = new SettingsService(path);
  assert.deepEqual(settings.get(), {
    approvalPolicy: "explicit",
    retainScreenshotsByDefault: false,
    vision: "always",
    recordVideo: true,
  });
  settings.update({ approvalPolicy: "autonomous", retainScreenshotsByDefault: true });
  settings = new SettingsService(path);
  assert.deepEqual(settings.get(), {
    approvalPolicy: "autonomous",
    retainScreenshotsByDefault: true,
    vision: "always",
    recordVideo: true,
  });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.throws(() => settings.update({ unknown: true }), /unknown field/);
  assert.throws(() => settings.update({ approvalPolicy: "sometimes" }), /approvalPolicy/);
});
