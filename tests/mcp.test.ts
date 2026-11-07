import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createTapRigMcpServer } from "../src/mcp/server.ts";

test("MCP lists and calls the daemon-backed TapRig tools", async (context) => {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const server = createTapRigMcpServer(async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.body) bodies.push(JSON.parse(String(init.body)) as unknown);
    if (path === "/devices") {
      return Response.json({ devices: [{ id: "phone-1", state: "ready" }] });
    }
    return Response.json({ accepted: true });
  });
  const client = new Client({ name: "taprig-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  context.after(async () => {
    await client.close();
    await server.close();
  });

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), [
    "taprig_act",
    "taprig_action",
    "taprig_approval",
    "taprig_devices",
    "taprig_observe",
    "taprig_run",
    "taprig_run_control",
    "taprig_screenshot",
    "taprig_task",
  ]);
  const inventory = await client.callTool({ name: "taprig_devices", arguments: {} });
  assert.match(JSON.stringify(inventory.content), /phone-1/);
  const action = await client.callTool({
    name: "taprig_action",
    arguments: { deviceId: "phone-1", action: { type: "key.press", key: "home" } },
  });
  assert.match(JSON.stringify(action.content), /accepted/);
  await client.callTool({
    name: "taprig_task",
    arguments: {
      task: "Open Settings",
      mode: "coordinated",
      maxModelCalls: 4,
      maxActions: 10,
      group: "social",
    },
  });
  await client.callTool({
    name: "taprig_run_control",
    arguments: { runId: "run-1", operation: "pause" },
  });
  await client.callTool({
    name: "taprig_approval",
    arguments: { runId: "run-1", approvalId: "approval-1", decision: "approved" },
  });
  assert.deepEqual(calls, [
    "GET /devices",
    "POST /devices/phone-1/actions",
    "POST /runs",
    "POST /runs/run-1/pause",
    "POST /runs/run-1/approvals/approval-1/resolve",
  ]);
  assert.deepEqual(bodies.at(-1), { decision: "approved" });

  assert.deepEqual(bodies.at(-2), {
    task: "Open Settings",
    mode: "coordinated",
    budget: { maxModelCalls: 4, maxActions: 10 },
    group: "social",
  });
  await client.callTool({ name: "taprig_observe", arguments: { deviceId: "phone-1" } });
  await client.callTool({
    name: "taprig_act",
    arguments: {
      deviceId: "phone-1",
      observationGeneration: "g1",
      steps: [
        { type: "element.tap", target: { elementId: "node-4" } },
        { type: "element.text", target: { text: "Search" }, value: "café", clear: true },
      ],
    },
  });
  const rejected = await client.callTool({
    name: "taprig_act",
    arguments: { deviceId: "phone-1", observationGeneration: "g1", steps: [{ type: "shell" }] },
  });
  assert.equal(rejected.isError, true);
  assert.deepEqual(calls.slice(-2), [
    "GET /devices/phone-1/observation",
    "POST /devices/phone-1/semantic-actions",
  ]);
  assert.deepEqual(bodies.at(-1), {
    observationGeneration: "g1",
    steps: [
      { type: "element.tap", target: { elementId: "node-4" } },
      { type: "element.text", target: { text: "Search" }, value: "café", clear: true },
    ],
  });
});
