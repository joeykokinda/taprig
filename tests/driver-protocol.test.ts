import assert from "node:assert/strict";
import test from "node:test";

import {
  DRIVER_MAX_MESSAGE_BYTES,
  DRIVER_PROTOCOL_VERSION,
  DriverFrameDecoder,
  encodeDriverRequest,
  parseDriverResult,
} from "../src/android/driver/protocol.ts";

const hello = {
  id: "hello-1",
  type: "hello",
  version: DRIVER_PROTOCOL_VERSION,
  nonce: "one-time-session-nonce",
} as const;

test("frames fragmented and multiple driver responses", () => {
  const decoder = new DriverFrameDecoder();
  assert.deepEqual(decoder.push(Buffer.from('{"id":"hello-1","ok":true,')), []);
  const responses = decoder.push(
    Buffer.from(
      '"result":{"version":1,"nonce":"one-time-session-nonce"}}\n' +
        '{"id":"health-1","ok":false,"error":{"code":"stopped","message":"gone"}}\n',
    ),
  );
  assert.deepEqual(parseDriverResult(hello, responses[0]!), {
    version: 1,
    nonce: "one-time-session-nonce",
  });
  assert.deepEqual(responses[1], {
    id: "health-1",
    ok: false,
    error: { code: "stopped", message: "gone" },
  });
});

test("encodes bounded newline-delimited requests", () => {
  const encoded = encodeDriverRequest({ id: "snapshot-1", type: "snapshot" });
  assert.equal(encoded.at(-1), 0x0a);
  assert.deepEqual(JSON.parse(encoded.subarray(0, -1).toString()), {
    id: "snapshot-1",
    type: "snapshot",
  });
  assert.throws(
    () =>
      encodeDriverRequest({
        id: "perform-1",
        type: "perform",
        expectedGeneration: "session:1",
        action: { type: "element.text", target: { text: "Field" }, value: "x".repeat(2 ** 20) },
      }),
    /exceeds/,
  );
});

test("rejects malformed, oversized, and structurally invalid frames", () => {
  assert.throws(() => new DriverFrameDecoder().push(Buffer.from("not json\n")), /valid UTF-8 JSON/);
  assert.throws(
    () => new DriverFrameDecoder().push(Buffer.alloc(DRIVER_MAX_MESSAGE_BYTES + 1, 0x20)),
    /exceeds/,
  );
  assert.throws(
    () =>
      new DriverFrameDecoder().push(
        Buffer.from('{"id":"x","ok":true,"result":{},"unexpected":true}\n'),
      ),
    /unexpected field/,
  );
});

test("binds replies to request id, protocol version, and session nonce", () => {
  const response = (result: object) => ({ id: hello.id, ok: true as const, result });
  assert.throws(
    () => parseDriverResult(hello, response({ version: 2, nonce: hello.nonce })),
    /version mismatch/,
  );
  assert.throws(
    () => parseDriverResult(hello, response({ version: 1, nonce: "other" })),
    /nonce mismatch/,
  );
  assert.throws(
    () =>
      parseDriverResult(hello, { ...response({ version: 1, nonce: hello.nonce }), id: "other" }),
    /unexpected driver response/,
  );
});

test("parses bounded typed snapshot and wait results", () => {
  const snapshot = {
    generation: "session:2",
    capturedAt: "2026-11-04T22:00:00.000Z",
    foregroundPackage: "com.android.settings",
    elements: [
      {
        id: "session:2/0",
        role: "button",
        text: "Network",
        actionable: true,
        bounds: { left: 0, top: 10, right: 100, bottom: 50 },
      },
      { id: "session:2/1", role: "Switch", actionable: true, checked: false },
    ],
  };
  assert.deepEqual(
    parseDriverResult(
      { id: "snapshot-1", type: "snapshot" },
      { id: "snapshot-1", ok: true, result: snapshot },
    ),
    snapshot,
  );
  assert.throws(
    () =>
      parseDriverResult(
        { id: "wait-1", type: "wait", afterGeneration: "session:1", timeoutMs: 1000 },
        { id: "wait-1", ok: true, result: { changed: false, snapshot } },
      ),
    /match changed state/,
  );
});
