import assert from "node:assert/strict";
import test from "node:test";

import { CredentialBroker } from "../src/security/credential-broker.ts";

const scope = { deviceId: "phone-1", purpose: "device.unlock" };

test("a secret is available only to its declared scope", () => {
  const broker = new CredentialBroker(() => "2026-10-29T00:00:00.000Z");
  const ref = broker.store("test-pin", scope);

  assert.throws(
    () => broker.access(ref, { ...scope, deviceId: "phone-2" }),
    /access denied: scope/,
  );
  assert.equal(broker.access(ref, scope), "test-pin");
  assert.equal(JSON.stringify(broker.audit()).includes("test-pin"), false);
});

test("one-time, expired, and revoked secrets cannot be reused", () => {
  let now = "2026-10-29T00:00:00.000Z";
  const broker = new CredentialBroker(() => now);

  const oneTime = broker.store("one-time", scope, { oneTime: true });
  assert.equal(broker.access(oneTime, scope), "one-time");
  assert.throws(() => broker.access(oneTime, scope), /consumed/);

  const expiring = broker.store("expiring", scope, {
    expiresAt: "2026-10-29T00:01:00.000Z",
  });
  now = "2026-10-29T00:01:00.000Z";
  assert.throws(() => broker.access(expiring, scope), /expired/);

  const revoked = broker.store("revoked", scope);
  broker.revoke(revoked);
  assert.throws(() => broker.access(revoked, scope), /revoked/);
});

test("missing references fail without exposing any stored value", () => {
  const broker = new CredentialBroker(() => "2026-10-29T00:00:00.000Z");
  broker.store("never-log-this", scope);

  assert.throws(() => broker.access({ id: "missing" }, scope), /missing/);
  assert.equal(JSON.stringify(broker.audit()).includes("never-log-this"), false);
});
