import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DriverCallError } from "../src/android/driver/protocol.ts";
import {
  AndroidDriverManager,
  AndroidDriverSession,
  connectDriver,
  type DriverCall,
  type DriverHost,
  type DriverRpc,
  loadDriverBundle,
} from "../src/android/driver/session.ts";
import type { ActionBatch } from "../src/core/contracts.ts";

const checksum = (value: string) => createHash("sha256").update(value).digest("hex");

async function artifacts(context: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "taprig-driver-session-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const targetApk = join(directory, "target.apk");
  const testApk = join(directory, "test.apk");
  await writeFile(targetApk, "target");
  await writeFile(testApk, "test");
  return {
    directory,
    targetApk,
    targetSha256: checksum("target"),
    testApk,
    testSha256: checksum("test"),
  };
}

function fakeHost(respond: (request: DriverCall) => unknown) {
  const commands: string[][] = [];
  const started: string[][] = [];
  const calls: DriverCall[] = [];
  const nonces: string[] = [];
  const stopped = { process: false, rpc: false };
  let alive = true;
  const rpc: DriverRpc = {
    get alive() {
      return alive;
    },
    call: async (request) => {
      calls.push(request);
      return respond(request) as never;
    },
    close: () => {
      stopped.rpc = true;
      alive = false;
    },
  };
  const host: DriverHost = {
    adb: async (args) => {
      commands.push([...args]);
      return args.includes("tcp:0") ? "43210\n" : "";
    },
    startAdb: (args) => {
      started.push([...args]);
      return {
        stop: () => {
          stopped.process = true;
        },
      };
    },
    connect: async (port, nonce) => {
      assert.equal(port, 43210);
      nonces.push(nonce);
      alive = true;
      return rpc;
    },
  };
  return { host, commands, started, calls, nonces, stopped, kill: () => (alive = false) };
}

const snapshot = {
  generation: "session:1",
  capturedAt: "2026-11-04T00:00:00.000Z",
  elements: [],
};

const batch: ActionBatch = {
  requestId: "request-1",
  deviceId: "phone-1",
  observationGeneration: "session:1",
  steps: [
    { id: "home", action: { type: "key.press", key: "home" } },
    { id: "back", action: { type: "key.press", key: "back" } },
    { id: "enter", action: { type: "key.press", key: "enter" } },
  ],
};

test("enrolls an authenticated driver session and cleans up its device resources", async (context) => {
  const files = await artifacts(context);
  let generation = 1;
  const fake = fakeHost((request) => {
    if (request.type === "snapshot") return snapshot;
    if (request.type === "perform") return { generation: `session:${++generation}`, evidence: "" };
    return { stopped: true };
  });
  const session = await AndroidDriverSession.enroll({
    ...files,
    serial: "phone-1",
    host: fake.host,
    nonce: "a".repeat(64),
  });

  assert.deepEqual(await session.observe(), { deviceId: "phone-1", ...snapshot });
  const result = await session.execute(batch);
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["verified", "verified", "verified"],
  );
  assert.deepEqual(
    fake.calls
      .filter((call) => call.type === "perform")
      .map((call) => (call.type === "perform" ? call.expectedGeneration : "")),
    ["session:1", "session:2", "session:3"],
  );
  assert.deepEqual(await session.execute(batch), { ...result, replayed: true });
  await session.close();
  await session.close();

  assert.deepEqual(
    fake.commands
      .filter((command) => command[2] === "install" || command[2] === "forward")
      .slice(0, 3),
    [
      ["-s", "phone-1", "install", "-t", "-r", files.targetApk],
      ["-s", "phone-1", "install", "-t", "-r", files.testApk],
      ["-s", "phone-1", "forward", "tcp:0", "localabstract:taprig-driver"],
    ],
  );
  assert.match(
    fake.started[0]?.join(" ") ?? "",
    /-e nonce a{64} dev\.taprig\.driver\/dev\.taprig\.driver\.TapRigInstrumentation$/u,
  );
  assert.deepEqual(fake.commands.slice(-2), [
    ["-s", "phone-1", "forward", "--remove", "tcp:43210"],
    ["-s", "phone-1", "shell", "am", "force-stop", "dev.taprig.driver.stub"],
  ]);
  assert.deepEqual(fake.stopped, { process: true, rpc: true });
  assert.equal(fake.calls.filter((call) => call.type === "stop").length, 1);
  await assert.rejects(session.observe(), /closed/);
});

test("stops a batch after a failed step and keeps the driver error code", async (context) => {
  const files = await artifacts(context);
  const fake = fakeHost((request) => {
    if (request.type !== "perform") return snapshot;
    if (request.expectedGeneration === "session:2") {
      throw new DriverCallError("target-not-found", "semantic target not found");
    }
    return { generation: "session:2", evidence: "" };
  });
  const session = await AndroidDriverSession.enroll({
    ...files,
    serial: "phone-1",
    host: fake.host,
  });
  const result = await session.execute(batch);
  assert.deepEqual(
    result.steps.map((step) => [step.status, step.error?.code]),
    [
      ["verified", undefined],
      ["failed", "target-not-found"],
      ["skipped", undefined],
    ],
  );
  await assert.rejects(session.execute({ ...batch, deviceId: "phone-2" }), /another device/);
});

test("skips installing APKs whose device copy already matches the bundle", async (context) => {
  const files = await artifacts(context);
  const fake = fakeHost(() => snapshot);
  const adb = fake.host.adb;
  fake.host.adb = async (args) => {
    if (args.includes("pm")) return `package:/data/app/${args.at(-1)}/base.apk\n`;
    if (args.includes("sha256sum")) {
      return `${args.at(-1)?.includes("stub") ? files.targetSha256 : "f".repeat(64)}  path\n`;
    }
    return adb(args);
  };
  const session = await AndroidDriverSession.enroll({
    ...files,
    serial: "phone-1",
    host: fake.host,
  });
  assert.deepEqual(
    fake.commands.filter((command) => command[2] === "install"),
    [["-s", "phone-1", "install", "-t", "-r", files.testApk]],
  );
  await session.close();
});

test("replaces a driver signed by another machine's key", async (context) => {
  const files = await artifacts(context);
  const fake = fakeHost(() => snapshot);
  const adb = fake.host.adb;
  let rejected = false;
  fake.host.adb = async (args) => {
    if (args[2] === "install" && args.at(-1) === files.testApk && !rejected) {
      rejected = true;
      throw new Error("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]");
    }
    return adb(args);
  };
  const session = await AndroidDriverSession.enroll({
    ...files,
    serial: "phone-1",
    host: fake.host,
  });
  assert.deepEqual(
    fake.commands.filter((command) => command[2] === "install" || command[2] === "uninstall"),
    [
      ["-s", "phone-1", "install", "-t", "-r", files.targetApk],
      ["-s", "phone-1", "uninstall", "dev.taprig.driver"],
      ["-s", "phone-1", "install", "-t", "-r", files.testApk],
    ],
  );
  await session.close();
});

test("clears this phone's stale driver forwards before enrolling", async (context) => {
  const files = await artifacts(context);
  const fake = fakeHost(() => snapshot);
  const adb = fake.host.adb;
  fake.host.adb = async (args) =>
    args[0] === "forward" && args[1] === "--list"
      ? "phone-1 tcp:1111 localabstract:taprig-driver\nphone-2 tcp:2222 localabstract:taprig-driver\nphone-1 tcp:3333 localabstract:scrcpy\n"
      : adb(args);
  const session = await AndroidDriverSession.enroll({
    ...files,
    serial: "phone-1",
    host: fake.host,
  });
  assert.deepEqual(
    fake.commands.filter((command) => command[2] === "forward" && command[3] === "--remove")[0],
    ["-s", "phone-1", "forward", "--remove", "tcp:1111"],
  );
  assert.equal(
    fake.commands.some((command) => command.includes("tcp:2222") || command.includes("tcp:3333")),
    false,
  );
  await session.close();
});

test("rejects changed APKs before mutating a device", async (context) => {
  const files = await artifacts(context);
  const fake = fakeHost(() => ({}));
  await assert.rejects(
    AndroidDriverSession.enroll({
      ...files,
      targetSha256: "0".repeat(64),
      serial: "phone-1",
      host: fake.host,
    }),
    /checksum mismatch/,
  );
  assert.deepEqual(fake.commands, []);
});

test("removes forwarding and instrumentation when authentication fails", async (context) => {
  const files = await artifacts(context);
  const fake = fakeHost(() => ({}));
  fake.host.connect = async () => {
    throw new Error("bad driver hello");
  };
  await assert.rejects(
    AndroidDriverSession.enroll({ ...files, serial: "phone-1", host: fake.host }),
    /bad driver hello/,
  );
  assert.equal(fake.stopped.process, true);
  assert.deepEqual(fake.commands.slice(-2), [
    ["-s", "phone-1", "forward", "--remove", "tcp:43210"],
    ["-s", "phone-1", "shell", "am", "force-stop", "dev.taprig.driver.stub"],
  ]);
});

test("manager enrolls phones with fresh nonces, closes removed and dead sessions", async (context) => {
  const files = await artifacts(context);
  const fake = fakeHost((request) => (request.type === "stop" ? { stopped: true } : snapshot));
  const manager = new AndroidDriverManager({ ...files, host: fake.host });
  await manager.sync(["phone-1"]);
  assert.ok(manager.get("phone-1"));
  fake.kill();
  assert.equal(manager.get("phone-1"), undefined);
  await manager.sync(["phone-1"]);
  assert.ok(manager.get("phone-1"));
  assert.equal(fake.nonces.length, 2);
  assert.notEqual(fake.nonces[0], fake.nonces[1]);
  assert.match(fake.nonces[0] ?? "", /^[a-f0-9]{64}$/u);
  await manager.sync([]);
  assert.equal(manager.get("phone-1"), undefined);
  assert.equal(fake.stopped.process, true);
  await manager.close();
});

test("manager keeps healthy phones when one phone fails enrollment and backs off retries", async (context) => {
  const files = await artifacts(context);
  const fake = fakeHost(() => snapshot);
  const install = fake.host.adb;
  fake.host.adb = async (args) => {
    if (args[1] === "bad-phone" && args[2] === "install") throw new Error("INSTALL_FAILED");
    return install(args);
  };
  let now = 0;
  const failures: string[] = [];
  const manager = new AndroidDriverManager({
    ...files,
    host: fake.host,
    now: () => now,
    retryAfterMs: 1000,
    onEnrollmentError: (serial) => failures.push(serial),
  });
  await manager.sync(["phone-1", "bad-phone"]);
  assert.ok(manager.get("phone-1"));
  assert.equal(manager.get("bad-phone"), undefined);
  await manager.sync(["phone-1", "bad-phone"]);
  assert.deepEqual(failures, ["bad-phone"]);
  now = 1000;
  await manager.sync(["phone-1", "bad-phone"]);
  assert.deepEqual(failures, ["bad-phone", "bad-phone"]);
  await manager.close();
});

async function fakeDriver(
  context: test.TestContext,
  handle: (request: Record<string, unknown>, socket: Socket) => void,
): Promise<number> {
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handle(JSON.parse(line), socket);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

const reply = (socket: Socket, id: unknown, result: unknown) =>
  socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);

test("loopback transport authenticates and correlates out-of-order replies", async (context) => {
  const nonce = "n".repeat(64);
  const held: Record<string, unknown>[] = [];
  const port = await fakeDriver(context, (request, socket) => {
    if (request.type === "hello") return reply(socket, request.id, { version: 1, nonce });
    if (request.type === "wait") return held.push(request);
    reply(socket, request.id, snapshot);
    const waiting = held.pop();
    if (waiting) reply(socket, waiting.id, { changed: false, snapshot: null });
  });
  const rpc = await connectDriver(port, nonce);
  assert.equal(rpc.alive, true);
  const waiting = rpc.call({ type: "wait", afterGeneration: "session:1", timeoutMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await rpc.call({ type: "snapshot" }), snapshot);
  assert.deepEqual(await waiting, { changed: false, snapshot: null });
  rpc.close();
  assert.equal(rpc.alive, false);
  await assert.rejects(rpc.call({ type: "snapshot" }), /closed/);
});

test("loopback transport rejects a wrong nonce, timeouts, and disconnects", async (context) => {
  const wrongNonce = await fakeDriver(context, (request, socket) =>
    reply(socket, request.id, { version: 1, nonce: "other" }),
  );
  await assert.rejects(connectDriver(wrongNonce, "n".repeat(64)), /nonce mismatch/);

  const silent = await fakeDriver(context, (request, socket) => {
    if (request.type === "hello") reply(socket, request.id, { version: 1, nonce: "n".repeat(64) });
  });
  const rpc = await connectDriver(silent, "n".repeat(64), { requestTimeoutMs: 30 });
  await assert.rejects(rpc.call({ type: "snapshot" }), /timed out/);
  assert.equal(rpc.alive, false);

  const hangup = await fakeDriver(context, (request, socket) => {
    if (request.type === "hello") reply(socket, request.id, { version: 1, nonce: "n".repeat(64) });
    else socket.destroy();
  });
  const dropped = await connectDriver(hangup, "n".repeat(64));
  await assert.rejects(dropped.call({ type: "health" }), /disconnected/);
  assert.equal(dropped.alive, false);
});

test("loads a driver bundle manifest and refuses path escapes", async (context) => {
  const files = await artifacts(context);
  const manifest = {
    protocolVersion: 1,
    stub: { file: "target.apk", sha256: files.targetSha256 },
    driver: { file: "test.apk", sha256: files.testSha256 },
  };
  await writeFile(join(files.directory, "manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(await loadDriverBundle(files.directory), {
    protocolVersion: 1,
    targetApk: files.targetApk,
    targetSha256: files.targetSha256,
    testApk: files.testApk,
    testSha256: files.testSha256,
  });
  await writeFile(
    join(files.directory, "manifest.json"),
    JSON.stringify({ ...manifest, driver: { file: "../x.apk", sha256: files.testSha256 } }),
  );
  await assert.rejects(loadDriverBundle(files.directory), /file is invalid/);
});
