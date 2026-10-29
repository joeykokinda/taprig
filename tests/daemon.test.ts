import assert from "node:assert/strict";
import test from "node:test";

import { startDaemon } from "../src/daemon/server.ts";

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
