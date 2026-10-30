import assert from "node:assert/strict";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createTapRigMcpServer } from "../src/mcp/server.ts";

test("MCP lists and calls the daemon-backed TapRig tools", async (context) => {
  const calls: string[] = [];
  const server = createTapRigMcpServer(async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
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
    "taprig_action",
    "taprig_devices",
    "taprig_run",
    "taprig_task",
  ]);
  const inventory = await client.callTool({ name: "taprig_devices", arguments: {} });
  assert.match(JSON.stringify(inventory.content), /phone-1/);
  const action = await client.callTool({
    name: "taprig_action",
    arguments: { deviceId: "phone-1", action: { type: "key.press", key: "home" } },
  });
  assert.match(JSON.stringify(action.content), /accepted/);
  assert.deepEqual(calls, ["GET /devices", "POST /devices/phone-1/actions"]);
});
