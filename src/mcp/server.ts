import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

import type { RunMode } from "../core/contracts.ts";
import { daemonRequest } from "../daemon/lifecycle.ts";

type RequestDaemon = (path: string, init?: RequestInit) => Promise<Response>;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

async function json(request: RequestDaemon, path: string, init?: RequestInit): Promise<unknown> {
  const response = await request(path, init);
  const value = await response.json();
  if (!response.ok) throw new Error(`TapRig daemon returned HTTP ${response.status}`);
  return value;
}

const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("app.launch"), packageName: z.string().min(3).max(300) }),
  z.object({
    type: z.literal("key.press"),
    key: z.enum(["back", "home", "recents", "enter", "delete"]),
  }),
  z.object({
    type: z.literal("gesture.tap"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("gesture.swipe"),
    from: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
    to: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
    durationMs: z.number().int().min(1).max(60_000),
  }),
]);

export function createTapRigMcpServer(request: RequestDaemon = daemonRequest): McpServer {
  const server = new McpServer({ name: "taprig", version: "0.0.0" });
  server.registerTool(
    "taprig_devices",
    {
      description: "List Android phones and their current TapRig readiness state.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => text(await json(request, "/devices")),
  );
  server.registerTool(
    "taprig_task",
    {
      description: "Start a durable natural-language phone task and return its run ID.",
      inputSchema: z.object({
        task: z.string().min(1).max(10_000),
        mode: z.enum(["independent", "broadcast", "coordinated"]).default("independent"),
      }),
    },
    async ({ task, mode }) =>
      text(
        await json(request, "/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task, mode: mode as RunMode }),
        }),
      ),
  );
  server.registerTool(
    "taprig_run",
    {
      description: "Read durable state and ordered events for a TapRig run.",
      inputSchema: z.object({ runId: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) =>
      text({
        ...((await json(request, `/runs/${encodeURIComponent(runId)}`)) as object),
        ...((await json(request, `/runs/${encodeURIComponent(runId)}/events`)) as object),
      }),
  );
  server.registerTool(
    "taprig_action",
    {
      description: "Send one validated raw Android action to a specific phone.",
      inputSchema: z.object({ deviceId: z.string().min(1).max(300), action }),
    },
    async ({ deviceId, action: selected }) =>
      text(
        await json(request, `/devices/${encodeURIComponent(deviceId)}/actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: selected }),
        }),
      ),
  );
  return server;
}

export function serveTapRigMcp(): void {
  serveStdio(() => createTapRigMcpServer(), {
    onerror: (error) => process.stderr.write(`TapRig MCP: ${error.message}\n`),
  });
}
