import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { isAbsolute, join } from "node:path";

import { parseAction, parseRawAction } from "../android/raw-actions.ts";
import type { ArtifactService } from "../artifacts/service.ts";
import { TakeoverLeases } from "../control/takeover.ts";
import type {
  Action,
  ActionBatch,
  BatchResult,
  DeviceCapability,
  Observation,
  RunBudget,
  RunMode,
} from "../core/contracts.ts";
import type { DeviceGroupService } from "../devices/groups.ts";
import type { ScheduleService } from "../runs/schedules.ts";
import type { RunService } from "../runs/service.ts";
import type { ScriptService } from "../scripts/service.ts";
import { CredentialBroker } from "../security/credential-broker.ts";
import type { SettingsService } from "../settings.ts";
import type { LiveMjpegStream } from "../video/live-stream.ts";

export interface DaemonDevice {
  id: string;
  serial: string;
  state: string;
  capabilities?: readonly DeviceCapability[];
}

/** Keeps the elements an agent can name or act on, dropping layout-only nodes. */
export function compactObservation(observation: Observation): Observation {
  return {
    ...observation,
    elements: observation.elements.filter(
      (element) => element.actionable || element.text || element.description || element.resourceId,
    ),
  };
}

export interface DeviceInventory {
  list(): Promise<readonly DaemonDevice[]>;
}

export interface TapRigDaemonOptions {
  token: string;
  devices: DeviceInventory;
  /** Semantic control for external agents such as Claude Code or Codex over MCP. */
  observe?: (deviceId: string) => Promise<Observation>;
  executeBatch?: (batch: ActionBatch) => Promise<BatchResult>;
  screenshot?: (deviceId: string) => Promise<Buffer>;
  deviceBusy?: (deviceId: string) => boolean;
  discoveryError?: () => string | undefined;
  host?: string;
  port?: number;
  execute?: (serial: string, action: Action) => Promise<void>;
  runs?: RunService;
  startRun?: (runId: string, deviceId?: string) => void;
  continueRun?: (runId: string) => void;
  resumeRun?: (
    runId: string,
    answer: {
      prompt: string;
      value: string;
      sensitive: boolean;
      kind?: "question" | "approval";
      deviceId?: string;
      deviceIds?: readonly string[];
    },
  ) => void;
  credentials?: CredentialBroker;
  groups?: DeviceGroupService;
  artifacts?: ArtifactService;
  scripts?: ScriptService;
  stream?: (serial: string) => Promise<LiveMjpegStream>;
  manualTap?: (serial: string, xRatio: number, yRatio: number) => Promise<void>;
  manualText?: (serial: string, text: string) => Promise<void>;
  notifications?: (serial: string) => Promise<unknown[]>;
  schedules?: ScheduleService;
  modelProfile?: string;
  modelProvider?: string;
  modelRequirement?: string;
  settings?: SettingsService;
}

async function jsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface RunningDaemon {
  url: string;
  stop(): Promise<void>;
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isAuthorized(
  header: string | undefined,
  cookie: string | undefined,
  token: string,
  browserSessions: ReadonlyMap<string, number>,
): boolean {
  const actual = Buffer.from(header ?? "");
  const expected = Buffer.from(`Bearer ${token}`);
  if (actual.length === expected.length && timingSafeEqual(actual, expected)) return true;
  const browserToken = cookie
    ?.split(";")
    .map((value) => value.trim().split("="))
    .find(([name]) => name === "taprig_session")?.[1];
  return Boolean(browserToken && (browserSessions.get(browserToken) ?? 0) > Date.now());
}

export async function startDaemon(options: TapRigDaemonOptions): Promise<RunningDaemon> {
  if (!options.token) throw new Error("daemon token must not be empty");
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("daemon must bind to loopback");
  }
  const pendingBrowserSessions = new Map<string, number>();
  const browserSessions = new Map<string, number>();
  const takeover = new TakeoverLeases();
  const credentials = options.credentials ?? new CredentialBroker();
  const configuredControlRoom = process.env.TAPRIG_CONTROL_ROOM;
  if (configuredControlRoom && !isAbsolute(configuredControlRoom)) {
    throw new Error("TAPRIG_CONTROL_ROOM must be an absolute path");
  }
  const controlRoom = configuredControlRoom ?? join(import.meta.dirname, "../../control-room");

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const now = Date.now();
    for (const [key, expiry] of pendingBrowserSessions)
      if (expiry <= now) pendingBrowserSessions.delete(key);
    for (const [key, expiry] of browserSessions) if (expiry <= now) browserSessions.delete(key);
    const browserSessionRoute = /^\/session\/([a-f0-9]{64})$/u.exec(url.pathname);
    if (request.method === "GET" && browserSessionRoute?.[1]) {
      const nonce = browserSessionRoute[1];
      if ((pendingBrowserSessions.get(nonce) ?? 0) <= now) {
        response.statusCode = 401;
        response.end("Expired browser session");
        return;
      }
      pendingBrowserSessions.delete(nonce);
      const session = randomBytes(32).toString("hex");
      browserSessions.set(session, now + 24 * 60 * 60 * 1000);
      response.statusCode = 302;
      response.setHeader(
        "set-cookie",
        `taprig_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
      );
      response.setHeader("location", "/");
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    if (
      !isAuthorized(
        request.headers.authorization,
        request.headers.cookie,
        options.token,
        browserSessions,
      )
    ) {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        response.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/browser-sessions") {
        const nonce = randomBytes(32).toString("hex");
        pendingBrowserSessions.set(nonce, Date.now() + 60_000);
        response.statusCode = 201;
        response.end(
          JSON.stringify({ url: `http://${request.headers.host ?? "127.0.0.1"}/session/${nonce}` }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/devices") {
        response.end(JSON.stringify({ devices: await options.devices.list() }));
        return;
      }
      const streamRoute = /^\/devices\/([^/]+)\/stream\.mjpeg$/u.exec(url.pathname);
      if (request.method === "GET" && streamRoute?.[1]) {
        if (!options.stream) throw new Error("live streaming is unavailable");
        const live = await options.stream(decodeURIComponent(streamRoute[1]));
        response.setHeader("content-type", "multipart/x-mixed-replace; boundary=ffmpeg");
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-content-type-options", "nosniff");
        live.stream.once("error", () => response.destroy());
        response.once("close", () => void live.stop());
        live.stream.pipe(response);
        return;
      }
      const takeoverRoute = /^\/devices\/([^/]+)\/takeover$/u.exec(url.pathname);
      if (takeoverRoute?.[1]) {
        const deviceId = decodeURIComponent(takeoverRoute[1]);
        try {
          if (request.method === "POST") {
            response.statusCode = 201;
            response.end(JSON.stringify({ lease: takeover.acquire(deviceId) }));
            return;
          }
          const body = (await jsonBody(request)) as { leaseId?: unknown };
          if (typeof body.leaseId !== "string") throw new Error("lease ID is required");
          if (request.method === "PATCH") {
            response.end(JSON.stringify({ lease: takeover.renew(deviceId, body.leaseId) }));
            return;
          }
          if (request.method === "DELETE") {
            takeover.release(deviceId, body.leaseId);
            response.statusCode = 204;
            response.end();
            return;
          }
        } catch {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "takeover-unavailable" }));
          return;
        }
      }
      const manualRoute = /^\/devices\/([^/]+)\/manual-actions$/u.exec(url.pathname);
      if (request.method === "POST" && manualRoute?.[1]) {
        const serial = decodeURIComponent(manualRoute[1]);
        try {
          const body = (await jsonBody(request)) as Record<string, unknown>;
          if (typeof body.leaseId !== "string") throw new Error("lease ID is required");
          takeover.require(serial, body.leaseId);
          if (
            body.type === "tap" &&
            typeof body.xRatio === "number" &&
            typeof body.yRatio === "number"
          ) {
            if (!options.manualTap) throw new Error("manual taps are unavailable");
            await options.manualTap(serial, body.xRatio, body.yRatio);
          } else if (body.type === "text" && typeof body.text === "string") {
            if (!options.manualText) throw new Error("manual text is unavailable");
            await options.manualText(serial, body.text);
          } else if (body.type === "key" && typeof body.key === "string") {
            if (!options.execute) throw new Error("manual keys are unavailable");
            await options.execute(serial, parseRawAction({ type: "key.press", key: body.key }));
          } else {
            throw new Error("invalid manual action");
          }
          response.end(JSON.stringify({ lease: takeover.renew(serial, body.leaseId) }));
        } catch {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "manual-action-rejected" }));
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/runs") {
        const runs = options.runs?.list() ?? [];
        response.end(
          JSON.stringify({
            runs,
            results: Object.fromEntries(
              runs.flatMap((run) => {
                const completion = options.runs?.completion(run.id)?.evidence as
                  | { summary?: unknown }
                  | undefined;
                return typeof completion?.summary === "string"
                  ? [[run.id, completion.summary]]
                  : [];
              }),
            ),
            telemetry: Object.fromEntries(
              runs.flatMap((run) => {
                const telemetry = options.runs?.telemetry(run.id)?.evidence;
                return telemetry === undefined ? [] : [[run.id, telemetry]];
              }),
            ),
          }),
        );
        return;
      }
      if (request.method === "GET" && url.pathname === "/setup") {
        const devices = await options.devices.list();
        const ready = devices.filter((device) => device.state === "ready").length;
        response.end(
          JSON.stringify({
            status: ready > 0 && options.startRun ? "ready" : "needs-attention",
            platform: process.platform,
            modelProfile: options.modelProfile ?? null,
            ...(options.discoveryError?.() ? { discoveryError: options.discoveryError() } : {}),
            modelProvider: options.modelProvider ?? null,
            modelRequirement: options.modelRequirement ?? null,
            agentConfigured: Boolean(options.startRun),
            hasRuns: (options.runs?.list().length ?? 0) > 0,
            devices: {
              total: devices.length,
              ready,
              states: Object.fromEntries(devices.map((device) => [device.serial, device.state])),
            },
          }),
        );
        return;
      }
      if (
        url.pathname === "/settings" &&
        (request.method === "GET" || request.method === "PATCH")
      ) {
        if (!options.settings) throw new Error("settings are unavailable");
        try {
          const settings =
            request.method === "PATCH"
              ? options.settings.update(await jsonBody(request))
              : options.settings.get();
          response.end(JSON.stringify({ settings }));
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-settings" }));
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/device-groups") {
        response.end(JSON.stringify({ groups: options.groups?.list() ?? [] }));
        return;
      }
      const groupRoute = /^\/device-groups\/([^/]+)$/u.exec(url.pathname);
      if ((request.method === "PUT" || request.method === "DELETE") && groupRoute?.[1]) {
        if (!options.groups) throw new Error("device groups are unavailable");
        try {
          const name = decodeURIComponent(groupRoute[1]);
          if (request.method === "DELETE") {
            if (!options.groups.delete(name)) {
              response.statusCode = 404;
              response.end(JSON.stringify({ error: "group-not-found" }));
            } else {
              response.statusCode = 204;
              response.end();
            }
          } else {
            const body = (await jsonBody(request)) as { deviceIds?: unknown };
            const group = options.groups.set(name, body.deviceIds as string[]);
            response.end(JSON.stringify({ group }));
          }
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-device-group" }));
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/scripts") {
        response.end(JSON.stringify({ scripts: options.scripts?.list() ?? [] }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/scripts") {
        if (!options.scripts) throw new Error("script service is unavailable");
        try {
          const script = options.scripts.create(await jsonBody(request));
          response.statusCode = 201;
          response.end(JSON.stringify({ script }));
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-script" }));
        }
        return;
      }
      const scriptRunRoute = /^\/scripts\/([^/]+)\/run$/u.exec(url.pathname);
      if (request.method === "POST" && scriptRunRoute?.[1]) {
        if (!options.scripts) throw new Error("script service is unavailable");
        try {
          const body = (await jsonBody(request)) as { deviceId?: unknown; inputs?: unknown };
          if (
            typeof body.deviceId !== "string" ||
            !body.inputs ||
            typeof body.inputs !== "object"
          ) {
            throw new Error("invalid script run");
          }
          const result = await options.scripts.run(
            decodeURIComponent(scriptRunRoute[1]),
            body.deviceId,
            body.inputs as Record<string, string>,
          );
          if (result.status === "recovery-needed" && options.runs && options.startRun) {
            const script = options.scripts.get(decodeURIComponent(scriptRunRoute[1]));
            const recovery = options.runs.create(
              `Recover the deterministic workflow "${script?.name ?? scriptRunRoute[1]}" after step ${result.stepId}. ${result.reason}`,
            );
            options.startRun(recovery.id, body.deviceId);
            response.end(JSON.stringify({ result, recoveryRun: recovery }));
          } else {
            response.end(JSON.stringify({ result }));
          }
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-script-run" }));
        }
        return;
      }
      const scriptRoute = /^\/scripts\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && scriptRoute?.[1]) {
        const script = options.scripts?.get(decodeURIComponent(scriptRoute[1]));
        if (!script) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "script-not-found" }));
          return;
        }
        response.end(JSON.stringify({ script }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/runs") {
        if (!options.runs) throw new Error("run service is unavailable");
        try {
          const body = (await jsonBody(request)) as {
            task?: unknown;
            mode?: unknown;
            budget?: unknown;
            group?: unknown;
            deviceIds?: unknown;
            retainScreenshots?: unknown;
          };
          if (typeof body.task !== "string") throw new Error("task must be a string");
          if (body.retainScreenshots !== undefined && typeof body.retainScreenshots !== "boolean") {
            throw new Error("retainScreenshots must be boolean");
          }
          if (body.group !== undefined && body.deviceIds !== undefined) {
            throw new Error("choose a group or explicit devices");
          }
          let affinity: { deviceIds: readonly string[]; group?: string } | undefined;
          if (body.group !== undefined) {
            if (typeof body.group !== "string" || !options.groups) {
              throw new Error("invalid group");
            }
            const group = options.groups.get(body.group);
            if (!group) throw new Error("group not found");
            affinity = { deviceIds: group.deviceIds, group: group.name };
          } else if (body.deviceIds !== undefined) {
            affinity = { deviceIds: body.deviceIds as string[] };
          }
          const run = options.runs.create(
            body.task,
            body.mode === undefined ? undefined : (body.mode as RunMode),
            body.budget as RunBudget | undefined,
            affinity,
            body.retainScreenshots === true ||
              (body.retainScreenshots === undefined &&
                options.settings?.get().retainScreenshotsByDefault === true),
          );
          const ready = new Set(
            (await options.devices.list().catch(() => []))
              .filter((device) => device.state === "ready")
              .map(({ id }) => id),
          );
          const affinityReady =
            !run.affinity ||
            (run.mode === "broadcast"
              ? run.affinity.deviceIds.every((id) => ready.has(id))
              : run.affinity.deviceIds.some((id) => ready.has(id)));
          if (affinityReady) options.startRun?.(run.id);
          response.statusCode = 201;
          response.end(JSON.stringify({ run }));
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-run" }));
        }
        return;
      }
      const eventRoute = /^\/runs\/([^/]+)\/events$/u.exec(url.pathname);
      if (request.method === "GET" && eventRoute?.[1]) {
        const runId = decodeURIComponent(eventRoute[1]);
        if (!options.runs?.get(runId)) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "run-not-found" }));
          return;
        }
        const after = Number(url.searchParams.get("after") ?? "0");
        if (!Number.isSafeInteger(after) || after < 0) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-event-sequence" }));
          return;
        }
        response.end(JSON.stringify({ events: options.runs.events(runId, after) }));
        return;
      }
      const questionsRoute = /^\/runs\/([^/]+)\/questions$/u.exec(url.pathname);
      if (request.method === "GET" && questionsRoute?.[1]) {
        try {
          const runId = decodeURIComponent(questionsRoute[1]);
          response.end(JSON.stringify({ questions: options.runs?.questions(runId) ?? [] }));
        } catch {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "run-not-found" }));
        }
        return;
      }
      const approvalsRoute = /^\/runs\/([^/]+)\/approvals$/u.exec(url.pathname);
      if (request.method === "GET" && approvalsRoute?.[1]) {
        try {
          const runId = decodeURIComponent(approvalsRoute[1]);
          response.end(JSON.stringify({ approvals: options.runs?.approvals(runId) ?? [] }));
        } catch {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "run-not-found" }));
        }
        return;
      }
      const telemetryRoute = /^\/runs\/([^/]+)\/telemetry$/u.exec(url.pathname);
      if (request.method === "GET" && telemetryRoute?.[1]) {
        const runId = decodeURIComponent(telemetryRoute[1]);
        if (!options.runs?.get(runId)) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "run-not-found" }));
          return;
        }
        response.end(
          JSON.stringify({ telemetry: options.runs.telemetry(runId)?.evidence ?? null }),
        );
        return;
      }
      const artifactsRoute = /^\/runs\/([^/]+)\/artifacts$/u.exec(url.pathname);
      if (request.method === "GET" && artifactsRoute?.[1]) {
        try {
          const artifacts = options.artifacts
            ?.list(decodeURIComponent(artifactsRoute[1]))
            .map(({ relativePath: _relativePath, ...artifact }) => artifact);
          response.end(JSON.stringify({ artifacts: artifacts ?? [] }));
        } catch {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "run-not-found" }));
        }
        return;
      }
      const artifactRoute = /^\/runs\/([^/]+)\/artifacts\/([^/]+)\/content$/u.exec(url.pathname);
      if (request.method === "GET" && artifactRoute?.[1] && artifactRoute[2]) {
        try {
          if (!options.artifacts) throw new Error("artifacts are unavailable");
          const runId = decodeURIComponent(artifactRoute[1]);
          const artifactId = decodeURIComponent(artifactRoute[2]);
          const artifact = options.artifacts.list(runId).find((item) => item.id === artifactId);
          if (!artifact) throw new Error("artifact not found");
          response.setHeader("content-type", artifact.mimeType);
          response.setHeader("content-disposition", `inline; filename="${artifact.id}"`);
          response.setHeader("x-content-type-options", "nosniff");
          response.end(await options.artifacts.read(runId, artifactId));
        } catch {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "artifact-not-found" }));
        }
        return;
      }
      const exportRoute = /^\/runs\/([^/]+)\/export$/u.exec(url.pathname);
      if (request.method === "GET" && exportRoute?.[1]) {
        try {
          if (!options.runs || !options.artifacts) throw new Error("run export is unavailable");
          const runId = decodeURIComponent(exportRoute[1]);
          const run = options.runs.get(runId);
          if (!run) throw new Error("run not found");
          response.setHeader("content-disposition", `attachment; filename="taprig-${run.id}.json"`);
          response.end(
            JSON.stringify({
              format: "taprig-run-export/v1",
              exportedAt: new Date().toISOString(),
              run,
              events: options.runs.events(runId),
              questions: options.runs.questions(runId),
              approvals: options.runs.approvals(runId),
              telemetry: options.runs.telemetry(runId)?.evidence ?? null,
              completion: options.runs.completion(runId)?.evidence ?? null,
              artifacts: await options.artifacts.payloads(runId),
            }),
          );
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "run-export-failed" }));
        }
        return;
      }
      const answerRoute = /^\/runs\/([^/]+)\/questions\/([^/]+)\/answer$/u.exec(url.pathname);
      if (request.method === "POST" && answerRoute?.[1] && answerRoute[2]) {
        if (!options.runs || !options.resumeRun) throw new Error("run answers are unavailable");
        try {
          const runId = decodeURIComponent(answerRoute[1]);
          const questionId = decodeURIComponent(answerRoute[2]);
          const body = (await jsonBody(request)) as { answer?: unknown; sensitive?: unknown };
          if (
            typeof body.answer !== "string" ||
            (body.sensitive !== undefined && typeof body.sensitive !== "boolean")
          ) {
            throw new Error("invalid answer");
          }
          const open = options.runs
            .questions(runId)
            .find((question) => question.id === questionId && question.status === "open");
          if (!open) throw new Error("question is not open");
          const sensitive = body.sensitive === true;
          let value = body.answer;
          if (sensitive) {
            const scope = {
              deviceId: open.deviceId ?? `run:${runId}`,
              purpose: `answer:${questionId}`,
            };
            const secret = credentials.store(value, scope, { oneTime: true });
            value = credentials.access(secret, scope);
          }
          const question = options.runs.answer(runId, questionId, value, sensitive);
          options.resumeRun(runId, {
            prompt: question.prompt,
            value,
            sensitive,
            ...(question.deviceId ? { deviceId: question.deviceId } : {}),
            ...(question.deviceIds ? { deviceIds: question.deviceIds } : {}),
          });
          response.end(JSON.stringify({ question }));
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-answer" }));
        }
        return;
      }
      const approvalRoute = /^\/runs\/([^/]+)\/approvals\/([^/]+)\/resolve$/u.exec(url.pathname);
      if (request.method === "POST" && approvalRoute?.[1] && approvalRoute[2]) {
        if (!options.runs || !options.resumeRun) throw new Error("run approvals are unavailable");
        try {
          const runId = decodeURIComponent(approvalRoute[1]);
          const approvalId = decodeURIComponent(approvalRoute[2]);
          const body = (await jsonBody(request)) as { decision?: unknown };
          if (body.decision !== "approved" && body.decision !== "denied") {
            throw new Error("invalid approval decision");
          }
          const approval = options.runs.resolveApproval(runId, approvalId, body.decision);
          if (body.decision === "approved") {
            options.resumeRun(runId, {
              prompt: approval.prompt,
              value: "Approved",
              sensitive: false,
              kind: "approval",
              ...(approval.deviceId ? { deviceId: approval.deviceId } : {}),
              ...(approval.deviceIds ? { deviceIds: approval.deviceIds } : {}),
            });
          } else {
            options.runs.record(runId, { type: "run.stopped", at: new Date().toISOString() });
          }
          response.end(JSON.stringify({ approval }));
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-approval" }));
        }
        return;
      }
      const controlRoute = /^\/runs\/([^/]+)\/(pause|resume|stop|retry)$/u.exec(url.pathname);
      if (request.method === "POST" && controlRoute?.[1] && controlRoute[2]) {
        if (!options.runs) throw new Error("run control is unavailable");
        try {
          const runId = decodeURIComponent(controlRoute[1]);
          const operation = controlRoute[2];
          if (operation === "retry") {
            const run = options.runs.retry(runId);
            const ready = new Set(
              (await options.devices.list().catch(() => []))
                .filter((device) => device.state === "ready")
                .map(({ id }) => id),
            );
            if (
              !run.affinity ||
              (run.mode === "broadcast"
                ? run.affinity.deviceIds.every((id) => ready.has(id))
                : run.affinity.deviceIds.some((id) => ready.has(id)))
            ) {
              options.startRun?.(run.id);
            }
            response.statusCode = 201;
            response.end(JSON.stringify({ run }));
          } else if (operation === "pause") {
            const run = options.runs.record(runId, {
              type: "run.paused",
              at: new Date().toISOString(),
            });
            response.end(JSON.stringify({ run }));
          } else if (operation === "resume") {
            if (!options.continueRun) throw new Error("run resume is unavailable");
            if (options.runs.get(runId)?.status !== "paused") throw new Error("run is not paused");
            options.continueRun(runId);
            response.end(JSON.stringify({ run: options.runs.get(runId) }));
          } else {
            const run = options.runs.record(runId, {
              type: "run.stopped",
              at: new Date().toISOString(),
            });
            response.end(JSON.stringify({ run }));
          }
        } catch {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "run-control-rejected" }));
        }
        return;
      }
      const promotionRoute = /^\/runs\/([^/]+)\/promote$/u.exec(url.pathname);
      if (request.method === "POST" && promotionRoute?.[1]) {
        if (!options.runs || !options.scripts) throw new Error("run promotion is unavailable");
        try {
          const runId = decodeURIComponent(promotionRoute[1]);
          const run = options.runs.get(runId);
          const completion = options.runs.completion(runId)?.evidence as
            | { actions?: Array<{ action?: Action }> }
            | undefined;
          const body = (await jsonBody(request)) as { id?: unknown; name?: unknown };
          if (
            run?.status !== "completed" ||
            typeof body.id !== "string" ||
            typeof body.name !== "string" ||
            !completion?.actions?.length
          ) {
            throw new Error("run is not promotable");
          }
          const current = options.scripts.get(body.id);
          const script = options.scripts.create({
            schemaVersion: 1,
            id: body.id,
            name: body.name,
            version: (current?.version ?? 0) + 1,
            origin: "learned",
            parameters: [],
            steps: completion.actions.map(({ action }, index) => ({
              id: `step-${index + 1}`,
              action,
            })),
          });
          response.statusCode = 201;
          response.end(JSON.stringify({ script }));
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "run-not-promotable" }));
        }
        return;
      }
      const runRoute = /^\/runs\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && runRoute?.[1]) {
        const run = options.runs?.get(decodeURIComponent(runRoute[1]));
        if (!run) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "run-not-found" }));
          return;
        }
        // The model's final evidence is the answer to a read task, so it travels with the run.
        const completion = options.runs?.completion(run.id)?.evidence as
          | { summary?: unknown }
          | undefined;
        const result = typeof completion?.summary === "string" ? completion.summary : undefined;
        response.end(JSON.stringify({ run, ...(result !== undefined ? { result } : {}) }));
        return;
      }
      if (
        url.pathname === "/schedules" &&
        (request.method === "GET" || request.method === "POST")
      ) {
        if (!options.schedules) throw new Error("schedules are unavailable");
        if (request.method === "GET") {
          response.end(JSON.stringify({ schedules: options.schedules.list() }));
          return;
        }
        try {
          const body = (await jsonBody(request)) as Record<string, unknown>;
          const schedule = options.schedules.add({
            task: body.task as string,
            mode: (body.mode as "independent" | undefined) ?? "independent",
            ...(body.everyMinutes !== undefined
              ? { everyMinutes: body.everyMinutes as number }
              : {}),
            ...(body.at !== undefined ? { at: body.at as string } : {}),
          });
          response.statusCode = 201;
          response.end(JSON.stringify({ schedule }));
        } catch (error) {
          response.statusCode = 400;
          response.end(
            JSON.stringify({
              error: "invalid-schedule",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        return;
      }
      const scheduleRoute = /^\/schedules\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "DELETE" && scheduleRoute?.[1]) {
        if (!options.schedules) throw new Error("schedules are unavailable");
        const removed = options.schedules.remove(decodeURIComponent(scheduleRoute[1]));
        response.statusCode = removed ? 200 : 404;
        response.end(JSON.stringify({ removed }));
        return;
      }
      const notificationsRoute = /^\/devices\/([^/]+)\/notifications$/u.exec(url.pathname);
      if (request.method === "GET" && notificationsRoute?.[1]) {
        if (!options.notifications) throw new Error("notifications are unavailable");
        response.end(
          JSON.stringify({
            notifications: await options.notifications(decodeURIComponent(notificationsRoute[1])),
          }),
        );
        return;
      }
      const semanticRoute =
        /^\/devices\/([^/]+)\/(observation|semantic-actions|screenshot\.png)$/u.exec(url.pathname);
      if (semanticRoute?.[1] && semanticRoute[2]) {
        const deviceId = decodeURIComponent(semanticRoute[1]);
        const device = (await options.devices.list()).find(
          (candidate) => candidate.id === deviceId,
        );
        if (device?.state !== "ready") {
          response.statusCode = 409;
          response.end(JSON.stringify({ error: "device-not-ready", state: device?.state ?? null }));
          return;
        }
        if (request.method === "GET" && semanticRoute[2] === "observation" && options.observe) {
          response.end(
            JSON.stringify({ observation: compactObservation(await options.observe(deviceId)) }),
          );
          return;
        }
        if (
          request.method === "GET" &&
          semanticRoute[2] === "screenshot.png" &&
          options.screenshot
        ) {
          response.setHeader("content-type", "image/png");
          response.setHeader("cache-control", "no-store");
          response.end(await options.screenshot(deviceId));
          return;
        }
        if (
          request.method === "POST" &&
          semanticRoute[2] === "semantic-actions" &&
          options.executeBatch &&
          options.observe
        ) {
          if (options.deviceBusy?.(deviceId)) {
            response.statusCode = 409;
            response.end(JSON.stringify({ error: "device-busy-with-run" }));
            return;
          }
          let batch: ActionBatch;
          try {
            const body = (await jsonBody(request)) as {
              observationGeneration?: unknown;
              steps?: unknown;
            };
            if (typeof body.observationGeneration !== "string" || !Array.isArray(body.steps)) {
              throw new Error("observationGeneration and steps are required");
            }
            if (body.steps.length < 1 || body.steps.length > 10) {
              throw new Error("steps must contain 1 to 10 actions");
            }
            batch = {
              requestId: randomBytes(12).toString("hex"),
              deviceId,
              observationGeneration: body.observationGeneration,
              steps: body.steps.map((step, index) => ({
                id: `step-${index + 1}`,
                action: parseAction((step as { action?: unknown })?.action ?? step),
              })),
            };
          } catch (error) {
            response.statusCode = 400;
            response.end(
              JSON.stringify({
                error: "invalid-action",
                message: error instanceof Error ? error.message : String(error),
              }),
            );
            return;
          }
          const result = await options.executeBatch(batch);
          response.end(
            JSON.stringify({
              result,
              observation: compactObservation(await options.observe(deviceId)),
            }),
          );
          return;
        }
      }
      const actionRoute = /^\/devices\/([^/]+)\/actions$/u.exec(url.pathname);
      if (request.method === "POST" && actionRoute?.[1]) {
        if (!options.execute) throw new Error("action execution is unavailable");
        const serial = decodeURIComponent(actionRoute[1]);
        let action: Action;
        try {
          const body = (await jsonBody(request)) as { action?: unknown };
          action = parseRawAction(body.action);
        } catch {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "invalid-action" }));
          return;
        }
        await options.execute(serial, action);
        response.statusCode = 202;
        response.end(JSON.stringify({ accepted: true, verified: false }));
        return;
      }
      const asset =
        url.pathname === "/"
          ? { file: "index.html", type: "text/html; charset=utf-8" }
          : url.pathname === "/control-room.css"
            ? { file: "control-room.css", type: "text/css; charset=utf-8" }
            : url.pathname === "/control-room.js"
              ? { file: "control-room.js", type: "text/javascript; charset=utf-8" }
              : undefined;
      if (request.method === "GET" && asset) {
        response.setHeader("content-type", asset.type);
        response.setHeader("cache-control", "no-store");
        response.setHeader("x-frame-options", "DENY");
        response.setHeader(
          "content-security-policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        );
        response.end(readFileSync(join(controlRoom, asset.file)));
        return;
      }

      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not-found" }));
    } catch {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "internal-error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await stopServer(server);
    throw new Error("daemon did not receive a TCP address");
  }

  return {
    url: `http://${host === "::1" ? `[${host}]` : host}:${address.port}`,
    stop: () => stopServer(server),
  };
}
