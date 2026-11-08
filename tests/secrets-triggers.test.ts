import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TriggerService } from "../src/runs/triggers.ts";
import { SecretStore } from "../src/security/secret-store.ts";

test("named secrets resolve tokens, list names only, and sit in a private file", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-secrets-"));
  context.after(() => rm(directory, { recursive: true }));
  const path = join(directory, "secrets.json");
  const store = new SecretStore(path);
  store.set("x_password", "hunter2!");
  assert.deepEqual(store.names(), ["x_password"]);
  assert.equal(store.resolve("pw: {{secret:x_password}}"), "pw: hunter2!");
  assert.deepEqual(store.referenced("Log in with {{secret:x_password}}"), ["hunter2!"]);
  assert.throws(() => store.resolve("{{secret:missing}}"), /unknown secret/u);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(new SecretStore(path).get("x_password"), "hunter2!");
});

test("triggers fire only for notifications newer than the first poll", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-triggers-"));
  context.after(() => rm(directory, { recursive: true }));
  const triggers = new TriggerService(join(directory, "triggers.json"));
  triggers.add("messaging.*Mom", "Read me the text from Mom");
  const old = {
    package: "com.google.android.apps.messaging",
    title: "Mom",
    text: "Call me",
    postedAt: "2026-11-08T10:00:00.000Z",
  };
  assert.deepEqual(triggers.fire("phone-1", [old]), [], "first poll only records");
  assert.deepEqual(triggers.fire("phone-1", [old]), [], "nothing new");
  const fresh = { ...old, text: "Dinner at 6?", postedAt: "2026-11-08T10:05:00.000Z" };
  const tasks = triggers.fire("phone-1", [fresh, old]);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0] ?? "", /Dinner at 6\?/u);
  assert.deepEqual(triggers.fire("phone-1", [fresh, old]), []);
  assert.throws(() => triggers.add("(", "x"), /Invalid regular expression|Unterminated/u);
});
