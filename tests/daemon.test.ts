import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { startDaemon } from "../src/daemon/server.ts";
import { TapRigStore } from "../src/persistence/store.ts";
import { RunService } from "../src/runs/service.ts";
import { ScriptService } from "../src/scripts/service.ts";
import { ScriptStore } from "../src/scripts/store.ts";

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

  const browserSession = await fetch(`${daemon.url}/browser-sessions`, {
    method: "POST",
    headers: authorization,
  });
  const sessionUrl = ((await browserSession.json()) as { url: string }).url;
  const exchange = await fetch(sessionUrl, { redirect: "manual" });
  assert.equal(exchange.status, 302);
  const cookie = exchange.headers.get("set-cookie");
  assert.ok(cookie);
  const controlRoom = await fetch(daemon.url, { headers: { cookie } });
  assert.equal(controlRoom.status, 200);
  assert.match(await controlRoom.text(), /TAPRIG/);
  assert.equal((await fetch(sessionUrl, { redirect: "manual" })).status, 401);
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

test("the daemon streams phones and gates manual input with takeover leases", async (context) => {
  const taps: unknown[] = [];
  let stopped = false;
  const daemon = await startDaemon({
    token,
    devices: { list: async () => [] },
    stream: async () => ({
      stream: Readable.from([Buffer.from("--ffmpeg\r\nContent-Type: image/jpeg\r\n\r\nframe")]),
      stop: async () => {
        stopped = true;
      },
    }),
    manualTap: async (serial, xRatio, yRatio) => {
      taps.push({ serial, xRatio, yRatio });
    },
  });
  context.after(() => daemon.stop());

  const stream = await fetch(`${daemon.url}/devices/phone-1/stream.mjpeg`, {
    headers: authorization,
  });
  assert.match(stream.headers.get("content-type") ?? "", /multipart\/x-mixed-replace/);
  assert.match(await stream.text(), /frame/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);

  const acquired = await fetch(`${daemon.url}/devices/phone-1/takeover`, {
    method: "POST",
    headers: authorization,
  });
  const lease = ((await acquired.json()) as { lease: { id: string } }).lease;
  assert.equal(
    (
      await fetch(`${daemon.url}/devices/phone-1/takeover`, {
        method: "POST",
        headers: authorization,
      })
    ).status,
    409,
  );
  const tapped = await fetch(`${daemon.url}/devices/phone-1/manual-actions`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ leaseId: lease.id, type: "tap", xRatio: 0.5, yRatio: 0.25 }),
  });
  assert.equal(tapped.status, 200);
  assert.deepEqual(taps, [{ serial: "phone-1", xRatio: 0.5, yRatio: 0.25 }]);
});

test("the daemon creates, lists, and attaches to durable runs", async (context) => {
  const started: string[] = [];
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
    startRun: (runId) => started.push(runId),
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
  assert.deepEqual(started, ["run-1"]);

  const listed = await fetch(`${daemon.url}/runs`, { headers: authorization });
  assert.equal(((await listed.json()) as { runs: unknown[] }).runs.length, 1);
  const attached = await fetch(`${daemon.url}/runs/run-1/events`, { headers: authorization });
  const events = (await attached.json()) as { events: Array<{ event: { type: string } }> };
  assert.equal(events.events[0]?.event.type, "run.created");
});

test("the daemon creates, inspects, and runs verified scripts", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-script-api-"));
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const started: Array<{ runId: string; deviceId?: string }> = [];
  const scripts = new ScriptService(new ScriptStore(directory), {
    observe: async () => ({
      deviceId: "phone-1",
      generation: "current",
      elements: [{ id: "node-1", role: "TextView", text: "Languages", actionable: false }],
      capturedAt: "2026-10-30T12:00:00.000Z",
    }),
    execute: async (batch) => ({
      requestId: batch.requestId,
      deviceId: batch.deviceId,
      steps: [{ stepId: "tap-system", status: "verified", durationMs: 1 }],
      replayed: false,
    }),
  });
  const daemon = await startDaemon({
    token,
    devices: { list: async () => [] },
    scripts,
    runs,
    startRun: (runId, deviceId) => started.push({ runId, ...(deviceId ? { deviceId } : {}) }),
  });
  context.after(async () => {
    await daemon.stop();
    store.close();
    await rm(directory, { recursive: true });
  });
  const definition = {
    schemaVersion: 1,
    id: "open-system",
    name: "Open System",
    version: 1,
    origin: "user",
    parameters: [],
    steps: [
      {
        id: "tap-system",
        action: { type: "element.tap", target: { text: "System" } },
        checkpoint: { selector: { text: "Languages" } },
      },
    ],
  };

  const created = await fetch(`${daemon.url}/scripts`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify(definition),
  });
  assert.equal(created.status, 201);
  const listed = await fetch(`${daemon.url}/scripts`, { headers: authorization });
  assert.equal(((await listed.json()) as { scripts: unknown[] }).scripts.length, 1);
  const run = await fetch(`${daemon.url}/scripts/open-system/run`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "phone-1", inputs: {} }),
  });
  assert.deepEqual(await run.json(), { result: { status: "completed", completedSteps: 1 } });

  scripts.create({
    ...definition,
    id: "recover-system",
    name: "Recover System",
    steps: [
      {
        ...definition.steps[0],
        checkpoint: { selector: { text: "Missing" } },
      },
    ],
  });
  const recovery = await fetch(`${daemon.url}/scripts/recover-system/run`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "phone-1", inputs: {} }),
  });
  const recoveryBody = (await recovery.json()) as {
    result: { status: string };
    recoveryRun: { id: string };
  };
  assert.equal(recoveryBody.result.status, "recovery-needed");
  assert.deepEqual(started.at(-1), { runId: recoveryBody.recoveryRun.id, deviceId: "phone-1" });

  const completed = runs.create("Open Settings");
  runs.record(completed.id, { type: "run.started", at: "2026-10-30T16:00:00.000Z" });
  runs.checkpoint(completed.id, "phone-1", {
    summary: "Settings visible",
    actions: [{ id: "open", action: { type: "app.launch", packageName: "com.android.settings" } }],
  });
  runs.record(completed.id, { type: "run.completed", at: "2026-10-30T16:00:01.000Z" });
  const promoted = await fetch(`${daemon.url}/runs/${completed.id}/promote`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ id: "open-settings", name: "Open Settings" }),
  });
  assert.equal(promoted.status, 201);
  assert.equal(
    ((await promoted.json()) as { script: { origin: string } }).script.origin,
    "learned",
  );
});
