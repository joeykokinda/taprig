import assert from "node:assert/strict";
import test from "node:test";

import type { UnlockAdb } from "../src/android/unlock.ts";
import { unlockWithPin } from "../src/android/unlock.ts";
import { CredentialBroker } from "../src/security/credential-broker.ts";

const serial = "phone-1";
const unlocked = "KeyguardServiceDelegate\n  showing=false\n  mIsShowing=false";
const locked = "KeyguardServiceDelegate\n  showing=true\n  mIsShowing=true";

test("does not access the credential when the phone is already unlocked", async () => {
  const broker = new CredentialBroker();
  const result = await unlockWithPin({
    serial,
    credential: { id: "missing" },
    broker,
    adb: async () => unlocked,
  });

  assert.equal(result, "already-unlocked");
  assert.equal(broker.audit().length, 0);
});

test("enters a scoped PIN and verifies keyguard dismissal", async () => {
  const broker = new CredentialBroker();
  const credential = broker.store("1234", { deviceId: serial, purpose: "device.unlock" });
  const calls: string[][] = [];
  let submitted = false;
  const adb: UnlockAdb = async (_serial, args) => {
    calls.push([...args]);
    if (args[0] === "wm") return "Physical size: 720x1600";
    if (args.includes("KEYCODE_ENTER")) submitted = true;
    if (args[0] === "dumpsys") return submitted ? unlocked : locked;
    return "";
  };

  const result = await unlockWithPin({
    serial,
    credential,
    broker,
    adb,
    wait: async () => {},
  });

  assert.equal(result, "unlocked");
  assert.ok(calls.some((args) => args.join(" ") === "input text 1234"));
  assert.equal(JSON.stringify(broker.audit()).includes("1234"), false);
});

test("fails without leaking a rejected PIN or claiming success", async () => {
  const broker = new CredentialBroker();
  const credential = broker.store("bad-pin", { deviceId: serial, purpose: "device.unlock" });

  await assert.rejects(
    unlockWithPin({ serial, credential, broker, adb: async () => locked }),
    /not a 4-16 digit PIN/,
  );
  assert.equal(JSON.stringify(broker.audit()).includes("bad-pin"), false);
});
