import assert from "node:assert/strict";
import test from "node:test";

import { TakeoverLeases } from "../src/control/takeover.ts";

test("takeover leases are exclusive, renewable, scoped, and expiring", () => {
  let now = 1_000_000;
  let sequence = 0;
  const leases = new TakeoverLeases(
    () => now,
    () => `lease-${++sequence}`,
    5_000,
  );
  const lease = leases.acquire("phone-1");

  assert.throws(() => leases.acquire("phone-1"), /already has/);
  assert.throws(() => leases.require("phone-2", lease.id), /does not match/);
  now += 4_000;
  assert.equal(leases.renew("phone-1", lease.id).expiresAt, new Date(now + 5_000).toISOString());
  now += 5_001;
  assert.throws(() => leases.require("phone-1", lease.id), /expired/);

  const replacement = leases.acquire("phone-1");
  leases.release("phone-1", replacement.id);
  assert.throws(() => leases.require("phone-1", replacement.id), /missing/);
});
