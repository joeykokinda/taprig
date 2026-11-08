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
  if (!response.ok) {
    const detail = value && typeof value === "object" ? JSON.stringify(value).slice(0, 500) : "";
    throw new Error(`TapRig daemon returned HTTP ${response.status} ${detail}`.trim());
  }
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

const selector = z.union([
  z.object({ elementId: z.string().min(1).max(200) }),
  z.object({ resourceId: z.string().min(1).max(500) }),
  z.object({ description: z.string().min(1).max(2_000) }),
  z.object({ text: z.string().min(1).max(2_000), role: z.string().min(1).max(200).optional() }),
]);

const semanticAction = z.union([
  action,
  z.object({ type: z.enum(["element.tap", "element.longTap"]), target: selector }),
  z.object({
    type: z.literal("element.text"),
    target: selector,
    value: z.string().max(10_000),
    clear: z.boolean().optional(),
  }),
]);

export function createTapRigMcpServer(request: RequestDaemon = daemonRequest): McpServer {
  const server = new McpServer({ name: "taprig", version: "0.1.0" });
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
        maxModelCalls: z.number().int().min(1).max(10_000).optional(),
        maxActions: z.number().int().min(1).max(10_000).optional(),
        group: z.string().min(1).max(64).optional(),
        deviceIds: z.array(z.string().min(1).max(300)).min(1).max(100).optional(),
        retainScreenshots: z.boolean().default(false),
      }),
    },
    async ({ task, mode, maxModelCalls, maxActions, group, deviceIds, retainScreenshots }) => {
      if (group && deviceIds) throw new Error("choose a group or explicit device IDs");
      return text(
        await json(request, "/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            task,
            mode: mode as RunMode,
            ...((maxModelCalls ?? maxActions) !== undefined
              ? { budget: { maxModelCalls, maxActions } }
              : {}),
            ...(group ? { group } : {}),
            ...(deviceIds ? { deviceIds } : {}),
            ...(retainScreenshots ? { retainScreenshots: true } : {}),
          }),
        }),
      );
    },
  );
  server.registerTool(
    "taprig_run",
    {
      description:
        "Read durable state, ordered events, open questions, and approvals for a TapRig run. A waiting-for-user run needs taprig_answer or taprig_approval.",
      inputSchema: z.object({ runId: z.string().min(1).max(200) }),
      annotations: { readOnlyHint: true },
    },
    async ({ runId }) =>
      text({
        ...((await json(request, `/runs/${encodeURIComponent(runId)}`)) as object),
        ...((await json(request, `/runs/${encodeURIComponent(runId)}/events`)) as object),
        ...((await json(request, `/runs/${encodeURIComponent(runId)}/questions`)) as object),
        ...((await json(request, `/runs/${encodeURIComponent(runId)}/approvals`)) as object),
        ...((await json(request, `/runs/${encodeURIComponent(runId)}/artifacts`)) as object),
      }),
  );
  server.registerTool(
    "taprig_approval",
    {
      description: "Approve or deny one open TapRig run approval.",
      inputSchema: z.object({
        runId: z.string().min(1).max(200),
        approvalId: z.string().min(1).max(200),
        decision: z.enum(["approved", "denied"]),
      }),
    },
    async ({ runId, approvalId, decision }) =>
      text(
        await json(
          request,
          `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/resolve`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision }),
          },
        ),
      ),
  );
  server.registerTool(
    "taprig_answer",
    {
      description:
        "Answer one open question from a waiting TapRig run (taprig_run shows them). Set sensitive for passwords and codes: the value then never reaches the model or logs, only the phone.",
      inputSchema: z.object({
        runId: z.string().min(1).max(200),
        questionId: z.string().min(1).max(200),
        answer: z.string().min(1).max(10_000),
        sensitive: z.boolean().default(false),
      }),
    },
    async ({ runId, questionId, answer, sensitive }) =>
      text(
        await json(
          request,
          `/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(questionId)}/answer`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ answer, sensitive }),
          },
        ),
      ),
  );
  server.registerTool(
    "taprig_run_control",
    {
      description: "Pause, resume, stop, or retry a durable TapRig run.",
      inputSchema: z.object({
        runId: z.string().min(1).max(200),
        operation: z.enum(["pause", "resume", "stop", "retry"]),
      }),
    },
    async ({ runId, operation }) =>
      text(
        await json(request, `/runs/${encodeURIComponent(runId)}/${operation}`, {
          method: "POST",
        }),
      ),
  );
  server.registerTool(
    "taprig_observe",
    {
      description:
        "Read one ready phone's current screen as semantic elements (id, role, text, description, resourceId, actionable, bounds) plus foregroundPackage and generation. Use before taprig_act.",
      inputSchema: z.object({ deviceId: z.string().min(1).max(300) }),
      annotations: { readOnlyHint: true },
    },
    async ({ deviceId }) =>
      text(await json(request, `/devices/${encodeURIComponent(deviceId)}/observation`)),
  );
  server.registerTool(
    "taprig_act",
    {
      description:
        "Run 1-10 actions on one phone against the generation from taprig_observe. Prefer element actions with an elementId target; each step is verified by a UI change, a failed step skips the rest, and the result includes the fresh observation. Fails with stale-observation if the screen changed first.",
      inputSchema: z.object({
        deviceId: z.string().min(1).max(300),
        observationGeneration: z.string().min(1).max(256),
        steps: z.array(semanticAction).min(1).max(10),
      }),
    },
    async ({ deviceId, observationGeneration, steps }) =>
      text(
        await json(request, `/devices/${encodeURIComponent(deviceId)}/semantic-actions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ observationGeneration, steps }),
        }),
      ),
  );
  server.registerTool(
    "taprig_screenshot",
    {
      description:
        "Capture one phone's screen as a PNG for visual surfaces the semantic tree cannot describe (games, canvases, images).",
      inputSchema: z.object({ deviceId: z.string().min(1).max(300) }),
      annotations: { readOnlyHint: true },
    },
    async ({ deviceId }) => {
      const response = await request(`/devices/${encodeURIComponent(deviceId)}/screenshot.png`);
      if (!response.ok) throw new Error(`TapRig daemon returned HTTP ${response.status}`);
      return {
        content: [
          {
            type: "image" as const,
            data: Buffer.from(await response.arrayBuffer()).toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    },
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
