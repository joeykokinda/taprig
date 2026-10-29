import assert from "node:assert/strict";
import test from "node:test";

import { startDaemon } from "../src/daemon/server.ts";
import { TapRigStore } from "../src/persistence/store.ts";
import { RunService } from "../src/runs/service.ts";

const token = "test-daemon-token";
const authorization = { authorization: `Bearer ${token}` };

test("the loopback daemon authenticates health and device inventory", async (context) => {
  const daemon = await startDaemon({
    token,
    devices: {
      async list() {
        return [{ id: "phone-1", serial: "serial-1", state: "ready" }];
      },
    },
  });
  context.after(() => daemon.stop());

  const denied = await fetch(`${daemon.url}/devices`);
  assert.equal(denied.status, 401);

  const health = await fetch(`${daemon.url}/health`, { headers: authorization });
  assert.deepEqual(await health.json(), { status: "ok" });

  const devices = await fetch(`${daemon.url}/devices`, { headers: authorization });
  assert.deepEqual(await devices.json(), {
    devices: [{ id: "phone-1", serial: "serial-1", state: "ready" }],
  });
});

test("the daemon rejects non-loopback binding", async () => {
  await assert.rejects(
    startDaemon({ token, host: "0.0.0.0", devices: { list: async () => [] } }),
    /must bind to loopback/,
  );
});

test("the daemon hides inventory failures", async (context) => {
  const daemon = await startDaemon({
    token,
    devices: {
      async list() {
        throw new Error("private device failure");
      },
    },
  });
  context.after(() => daemon.stop());

  const response = await fetch(`${daemon.url}/devices`, { headers: authorization });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal-error" });
});

test("the daemon validates and forwards authenticated raw actions", async (context) => {
  const actions: unknown[] = [];
  const daemon = await startDaemon({
    token,
    devices: { list: async () => [] },
    execute: async (serial, action) => {
      actions.push({ serial, action });
    },
  });
  context.after(() => daemon.stop());

  const accepted = await fetch(`${daemon.url}/devices/phone-1/actions`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ action: { type: "key.press", key: "home" } }),
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(actions, [{ serial: "phone-1", action: { type: "key.press", key: "home" } }]);

  const rejected = await fetch(`${daemon.url}/devices/phone-1/actions`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ action: { type: "shell", command: "whoami" } }),
  });
  assert.equal(rejected.status, 400);
  assert.deepEqual(actions.length, 1);
});

test("the daemon creates, lists, and attaches to durable runs", async (context) => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(
    store,
    () => "2026-10-29T12:00:00.000Z",
    () => "run-1",
  );
  const daemon = await startDaemon({
    token,
    devices: { list: async () => [] },
    runs,
  });
  context.after(async () => {
    await daemon.stop();
    store.close();
  });

  const created = await fetch(`${daemon.url}/runs`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ task: "Open System settings", mode: "independent" }),
  });
  assert.equal(created.status, 201);
  assert.equal(((await created.json()) as { run: { id: string } }).run.id, "run-1");

  const listed = await fetch(`${daemon.url}/runs`, { headers: authorization });
  assert.equal(((await listed.json()) as { runs: unknown[] }).runs.length, 1);
  const attached = await fetch(`${daemon.url}/runs/run-1/events`, { headers: authorization });
  const events = (await attached.json()) as { events: Array<{ event: { type: string } }> };
  assert.equal(events.events[0]?.event.type, "run.created");
});
