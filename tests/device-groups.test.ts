import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DeviceGroupService } from "../src/devices/groups.ts";
import { TapRigStore } from "../src/persistence/store.ts";

test("device groups are validated, updated, listed, and deleted durably", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-groups-"));
  context.after(() => rm(directory, { recursive: true }));
  const path = join(directory, "taprig.db");
  let store = new TapRigStore(path);
  let now = "2026-11-01T12:00:00.000Z";
  let groups = new DeviceGroupService(store, () => now);

  const created = groups.set("social", ["phone-2", "phone-1"]);
  assert.deepEqual(created.deviceIds, ["phone-2", "phone-1"]);
  now = "2026-11-01T12:01:00.000Z";
  const updated = groups.set("social", ["phone-3"]);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, now);
  assert.deepEqual(groups.list(), [updated]);
  assert.throws(() => groups.set("bad name", ["phone-1"]), /group name/);
  assert.throws(() => groups.set("empty", []), /1 to 100/);
  assert.throws(() => groups.set("duplicate", ["phone-1", "phone-1"]), /unique/);
  store.close();
  store = new TapRigStore(path);
  groups = new DeviceGroupService(store, () => now);
  assert.deepEqual(groups.list(), [updated]);
  assert.equal(groups.delete("social"), true);
  assert.equal(groups.get("social"), undefined);
  store.close();
});
