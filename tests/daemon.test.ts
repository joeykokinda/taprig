import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { ArtifactService } from "../src/artifacts/service.ts";
import { startDaemon } from "../src/daemon/server.ts";
import { DeviceGroupService } from "../src/devices/groups.ts";
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
  const controlRoomHtml = await controlRoom.text();
  assert.match(controlRoomHtml, /TAPRIG/);
  assert.match(controlRoomHtml, /ACTIVE REPLAY/);
  assert.match(controlRoomHtml, /DEVICE GROUPS/);
  assert.match(controlRoomHtml, /GET THE RIG ONLINE/);
  assert.equal((await fetch(sessionUrl, { redirect: "manual" })).status, 401);
});

test("setup reports actionable readiness without exposing provider secrets", async (context) => {
  const secret = "never-return-this-provider-secret";
  process.env.TAPRIG_TEST_PROVIDER_KEY = secret;
  context.after(() => delete process.env.TAPRIG_TEST_PROVIDER_KEY);
  const daemon = await startDaemon({
    token,
    devices: { list: async () => [{ id: "phone-1", serial: "serial-1", state: "offline" }] },
    modelProfile: "balanced",
    modelKeyEnv: "TAPRIG_TEST_PROVIDER_KEY",
  });
  context.after(() => daemon.stop());

  const response = await fetch(`${daemon.url}/setup`, { headers: authorization });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(body.includes(secret), false);
  assert.deepEqual(JSON.parse(body), {
    status: "needs-attention",
    platform: process.platform,
    modelProfile: "balanced",
    modelKeyEnv: "TAPRIG_TEST_PROVIDER_KEY",
    agentConfigured: false,
    hasRuns: false,
    devices: { total: 1, ready: 0, states: { "serial-1": "offline" } },
  });
});

test("setup is ready when a phone and agent worker are ready", async (context) => {
  const daemon = await startDaemon({
    token,
    devices: { list: async () => [{ id: "phone-1", serial: "serial-1", state: "ready" }] },
    startRun: () => undefined,
  });
  context.after(() => daemon.stop());

  const response = await fetch(`${daemon.url}/setup`, { headers: authorization });
  const body = (await response.json()) as {
    status: string;
    agentConfigured: boolean;
    devices: { ready: number };
  };
  assert.deepEqual(
    { status: body.status, agentConfigured: body.agentConfigured, ready: body.devices.ready },
    { status: "ready", agentConfigured: true, ready: 1 },
  );
});

test("the daemon rejects non-loopback binding", async () => {
  await assert.rejects(
    startDaemon({ token, host: "0.0.0.0", devices: { list: async () => [] } }),
    /must bind to loopback/,
  );
});

test("the daemon rejects a relative control-room override", async () => {
  const previous = process.env.TAPRIG_CONTROL_ROOM;
  process.env.TAPRIG_CONTROL_ROOM = "relative/control-room";
  try {
    await assert.rejects(
      startDaemon({ token, devices: { list: async () => [] } }),
      /TAPRIG_CONTROL_ROOM must be an absolute path/,
    );
  } finally {
    if (previous === undefined) delete process.env.TAPRIG_CONTROL_ROOM;
    else process.env.TAPRIG_CONTROL_ROOM = previous;
  }
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
    body: JSON.stringify({
      task: "Open System settings",
      mode: "independent",
      budget: { maxModelCalls: 6, maxActions: 20 },
    }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual(((await created.json()) as { run: { id: string; budget: unknown } }).run, {
    id: "run-1",
    mode: "independent",
    budget: { maxModelCalls: 6, maxActions: 20 },
    task: "Open System settings",
    status: "created",
    createdAt: "2026-10-29T12:00:00.000Z",
    updatedAt: "2026-10-29T12:00:00.000Z",
  });
  assert.deepEqual(started, ["run-1"]);
  const rejected = await fetch(`${daemon.url}/runs`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ task: "Bad", budget: { maxActions: -1 } }),
  });
  assert.equal(rejected.status, 400);
  runs.saveTelemetry("run-1", { modelCalls: 2, inputTokens: 100, outputTokens: 20 });

  const listed = await fetch(`${daemon.url}/runs`, { headers: authorization });
  const inventory = (await listed.json()) as {
    runs: unknown[];
    telemetry: Record<string, unknown>;
  };
  assert.equal(inventory.runs.length, 1);
  assert.deepEqual(inventory.telemetry["run-1"], {
    modelCalls: 2,
    inputTokens: 100,
    outputTokens: 20,
  });
  const attached = await fetch(`${daemon.url}/runs/run-1/events`, { headers: authorization });
  const events = (await attached.json()) as { events: Array<{ event: { type: string } }> };
  assert.equal(events.events[0]?.event.type, "run.created");
  const telemetry = await fetch(`${daemon.url}/runs/run-1/telemetry`, {
    headers: authorization,
  });
  assert.deepEqual((await telemetry.json()) as unknown, {
    telemetry: { modelCalls: 2, inputTokens: 100, outputTokens: 20 },
  });
});

test("the daemon manages groups and resolves immutable run affinity", async (context) => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const groups = new DeviceGroupService(store);
  const started: string[] = [];
  const daemon = await startDaemon({
    token,
    devices: {
      list: async () => [
        { id: "phone-1", serial: "phone-1", state: "ready" },
        { id: "phone-2", serial: "phone-2", state: "ready" },
        { id: "phone-3", serial: "phone-3", state: "ready" },
      ],
    },
    groups,
    runs,
    startRun: (runId) => started.push(runId),
  });
  context.after(async () => {
    await daemon.stop();
    store.close();
  });

  const saved = await fetch(`${daemon.url}/device-groups/social`, {
    method: "PUT",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ deviceIds: ["phone-1", "phone-2"] }),
  });
  assert.equal(saved.status, 200);
  const created = await fetch(`${daemon.url}/runs`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ task: "Post everywhere", mode: "broadcast", group: "social" }),
  });
  const run = ((await created.json()) as { run: { id: string; affinity: unknown } }).run;
  assert.deepEqual(run.affinity, {
    group: "social",
    deviceIds: ["phone-1", "phone-2"],
  });
  assert.deepEqual(started, [run.id]);

  groups.set("social", ["phone-3"]);
  assert.deepEqual(runs.get(run.id)?.affinity?.deviceIds, ["phone-1", "phone-2"]);
  groups.set("offline", ["phone-4"]);
  const queued = await fetch(`${daemon.url}/runs`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ task: "Wait for phone", group: "offline" }),
  });
  const queuedRun = ((await queued.json()) as { run: { id: string; status: string } }).run;
  assert.equal(queuedRun.status, "created");
  assert.deepEqual(started, [run.id]);
  const listed = await fetch(`${daemon.url}/device-groups`, { headers: authorization });
  const inventory = (await listed.json()) as {
    groups: Array<{ name: string; deviceIds: string[] }>;
  };
  assert.deepEqual(inventory.groups.find(({ name }) => name === "social")?.deviceIds, ["phone-3"]);
  const removed = await fetch(`${daemon.url}/device-groups/social`, {
    method: "DELETE",
    headers: authorization,
  });
  assert.equal(removed.status, 204);
});

test("the daemon resumes questions without persisting sensitive answers", async (context) => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Sign in");
  runs.record(run.id, { type: "run.started", at: "2026-10-29T12:00:01.000Z" });
  const question = runs.question(run.id, "What is the one-time code?", "phone-1");
  runs.record(run.id, { type: "run.waitingForUser", at: "2026-10-29T12:00:02.000Z" });
  const resumed: Array<{
    runId: string;
    prompt: string;
    value: string;
    sensitive: boolean;
    deviceId?: string;
  }> = [];
  const daemon = await startDaemon({
    token,
    devices: { list: async () => [] },
    runs,
    resumeRun: (runId, answer) => resumed.push({ runId, ...answer }),
  });
  context.after(async () => {
    await daemon.stop();
    store.close();
  });

  const response = await fetch(`${daemon.url}/runs/${run.id}/questions/${question.id}/answer`, {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify({ answer: " 123456 ", sensitive: true }),
  });
  assert.equal(response.status, 200);
  const stored = runs.questions(run.id)[0];
  assert.equal(stored?.status, "answered");
  assert.equal(stored?.sensitive, true);
  assert.equal(stored?.answer, undefined);
  assert.deepEqual(resumed, [
    {
      runId: run.id,
      prompt: "What is the one-time code?",
      value: " 123456 ",
      sensitive: true,
      deviceId: "phone-1",
    },
  ]);

  const listed = await fetch(`${daemon.url}/runs/${run.id}/questions`, {
    headers: authorization,
  });
  assert.equal(JSON.stringify(await listed.json()).includes("123456"), false);
});

test("the daemon lists and resolves typed approvals", async (context) => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const approvedRun = runs.create("Send a message");
  runs.record(approvedRun.id, { type: "run.started", at: "2026-11-02T12:00:01.000Z" });
  const approval = runs.approval(approvedRun.id, "Send the drafted message?", "phone-1");
  runs.record(approvedRun.id, {
    type: "run.waitingForUser",
    at: "2026-11-02T12:00:02.000Z",
  });
  const deniedRun = runs.create("Delete a draft");
  runs.record(deniedRun.id, { type: "run.started", at: "2026-11-02T12:00:03.000Z" });
  const denied = runs.approval(deniedRun.id, "Delete the draft?", "phone-1");
  runs.record(deniedRun.id, { type: "run.waitingForUser", at: "2026-11-02T12:00:04.000Z" });
  const resumed: unknown[] = [];
  const daemon = await startDaemon({
    token,
    devices: { list: async () => [] },
    runs,
    resumeRun: (runId, answer) => resumed.push({ runId, ...answer }),
  });
  context.after(async () => {
    await daemon.stop();
    store.close();
  });

  const listed = await fetch(`${daemon.url}/runs/${approvedRun.id}/approvals`, {
    headers: authorization,
  });
  assert.equal(listed.status, 200);
  assert.equal(((await listed.json()) as { approvals: unknown[] }).approvals.length, 1);
  const accepted = await fetch(
    `${daemon.url}/runs/${approvedRun.id}/approvals/${approval.id}/resolve`,
    {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    },
  );
  assert.equal(accepted.status, 200);
  assert.deepEqual(resumed, [
    {
      runId: approvedRun.id,
      prompt: "Send the drafted message?",
      value: "Approved",
      sensitive: false,
      kind: "approval",
      deviceId: "phone-1",
    },
  ]);
  const rejected = await fetch(
    `${daemon.url}/runs/${deniedRun.id}/approvals/${denied.id}/resolve`,
    {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ decision: "denied" }),
    },
  );
  assert.equal(rejected.status, 200);
  assert.equal(runs.get(deniedRun.id)?.status, "stopped");
});

test("the daemon serves run artifacts and a portable trace export", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-artifact-api-"));
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Capture evidence");
  runs.record(run.id, { type: "run.started", at: "2026-11-04T12:00:01.000Z" });
  const artifacts = new ArtifactService(join(directory, "artifacts"), store, () => "image-1");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  await artifacts.screenshot(run.id, "phone-1", async () => png);
  runs.record(run.id, { type: "run.completed", at: "2026-11-04T12:00:02.000Z" });
  const daemon = await startDaemon({ token, devices: { list: async () => [] }, runs, artifacts });
  context.after(async () => {
    await daemon.stop();
    store.close();
    await rm(directory, { recursive: true });
  });

  const listed = await fetch(`${daemon.url}/runs/${run.id}/artifacts`, {
    headers: authorization,
  });
  const inventory = (await listed.json()) as { artifacts: Array<Record<string, unknown>> };
  assert.equal(inventory.artifacts.length, 1);
  assert.equal("relativePath" in (inventory.artifacts[0] ?? {}), false);
  const content = await fetch(`${daemon.url}/runs/${run.id}/artifacts/image-1/content`, {
    headers: authorization,
  });
  assert.equal(content.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
  const exported = await fetch(`${daemon.url}/runs/${run.id}/export`, {
    headers: authorization,
  });
  const bundle = (await exported.json()) as {
    format: string;
    run: { id: string };
    artifacts: Array<{ data: string }>;
  };
  assert.equal(bundle.format, "taprig-run-export/v1");
  assert.equal(bundle.run.id, run.id);
  assert.equal(bundle.artifacts[0]?.data, png.toString("base64"));
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
