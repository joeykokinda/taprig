import assert from "node:assert/strict";
import test from "node:test";

import {
  dumpUiHierarchy,
  parseUiHierarchy,
  resolveElement,
  tapSemanticElement,
} from "../src/android/semantic.ts";

const hierarchy = `UI hierchary dumped to: /dev/tty
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" content-desc="" clickable="false" long-clickable="false" scrollable="false" bounds="[0,0][720,1600]">
    <node index="1" text="Network &amp; internet" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" content-desc="" clickable="true" long-clickable="false" scrollable="false" bounds="[24,180][696,280]" />
    <node index="2" text="" resource-id="" class="android.widget.ImageButton" package="com.android.settings" content-desc="Navigate up" clickable="true" long-clickable="false" scrollable="false" bounds="[0,80][96,176]" />
  </node>
</hierarchy>`;

const nestedHierarchy = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.LinearLayout" package="com.android.settings" clickable="true" bounds="[0,200][720,320]">
    <node text="System" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" clickable="false" bounds="[24,210][696,260]" />
  </node>
</hierarchy>`;

test("parses a bounded semantic observation with a stable generation", () => {
  const first = parseUiHierarchy("phone-1", hierarchy, "2026-10-29T03:00:00.000Z");
  const second = parseUiHierarchy("phone-1", hierarchy, "2026-10-29T03:00:01.000Z");

  assert.equal(first.generation, second.generation);
  assert.equal(first.foregroundPackage, "com.android.settings");
  assert.deepEqual(first.elements[1], {
    id: "node-1",
    role: "TextView",
    text: "Network & internet",
    resourceId: "android:id/title",
    actionable: true,
    bounds: { left: 24, top: 180, right: 696, bottom: 280 },
  });
  assert.equal(resolveElement(first, { description: "Navigate up" }).id, "node-2");
});

test("dumps through a unique device file and always removes it", async () => {
  const calls: string[][] = [];
  const output = await dumpUiHierarchy("phone-1", async (_serial, args) => {
    calls.push([...args]);
    return args[0] === "exec-out" ? hierarchy : "UI hierarchy dumped";
  });

  assert.equal(output, hierarchy);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0]?.slice(0, 3), ["shell", "uiautomator", "dump"]);
  assert.deepEqual(calls[1]?.slice(0, 2), ["exec-out", "cat"]);
  assert.deepEqual(calls[2]?.slice(0, 3), ["shell", "rm", "-f"]);
  assert.equal(calls[0]?.at(-1), calls[1]?.at(-1));
  assert.equal(calls[1]?.at(-1), calls[2]?.at(-1));
});

test("taps the center of one unambiguous current semantic element", async () => {
  const observation = parseUiHierarchy("phone-1", hierarchy);
  let args: readonly string[] = [];
  await tapSemanticElement(
    "phone-1",
    observation,
    { text: "Network & internet" },
    async (_serial, next) => {
      args = next;
    },
  );

  assert.deepEqual(args, ["input", "tap", "360", "230"]);
});

test("associates a child label with its clickable parent", async () => {
  const observation = parseUiHierarchy("phone-1", nestedHierarchy);
  const parent = resolveElement(observation, { text: "System" });
  assert.equal(parent.id, "node-0");
  assert.equal(parent.actionable, true);

  let args: readonly string[] = [];
  await tapSemanticElement("phone-1", observation, { text: "System" }, async (_serial, next) => {
    args = next;
  });
  assert.deepEqual(args, ["input", "tap", "360", "260"]);
});

test("rejects missing, ambiguous, and untappable semantic targets", async () => {
  const observation = parseUiHierarchy("phone-1", hierarchy);
  const duplicate = observation.elements[1];
  assert.ok(duplicate);
  const ambiguous = {
    ...observation,
    elements: [...observation.elements, { ...duplicate, id: "duplicate" }],
  };
  assert.throws(() => resolveElement(observation, { text: "Missing" }), /not found/);
  assert.throws(() => resolveElement(ambiguous, { text: "Network & internet" }), /ambiguous/);
  await assert.rejects(
    tapSemanticElement("phone-1", observation, { elementId: "node-0" }, async () => {}),
    /not tappable/,
  );
});
