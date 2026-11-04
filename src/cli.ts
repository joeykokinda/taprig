#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import { type AdbDevice, formatAdbDevices } from "./android/adb-discovery.ts";
import { parseAnswerCommand } from "./answer-command.ts";
import type { RunBudget, RunEvent, RunMode, RunState, RunTelemetry } from "./core/contracts.ts";
import {
  daemonRequest,
  daemonStatus,
  serveDaemon,
  startDaemonProcess,
  stopDaemonProcess,
} from "./daemon/lifecycle.ts";
import { diagnoseAdbDevices, formatDoctorFindings } from "./doctor.ts";
import { parseExecuteCommand } from "./execute-command.ts";
import { serveTapRigMcp } from "./mcp/server.ts";
import {
  loadOrCreateModelConfig,
  type ModelProfileName,
  type ModelRole,
  saveModelConfig,
} from "./models/config.ts";
import { parseRunCommand, parseRunMode } from "./run-command.ts";
import type { ScriptRunResult, TapRigScript } from "./scripts/contracts.ts";
import type { TapRigSettings } from "./settings.ts";

interface SetupStatus {
  status: "ready" | "needs-attention";
  platform: string;
  modelProfile: string | null;
  modelKeyEnv: string | null;
  agentConfigured: boolean;
  hasRuns: boolean;
  devices: {
    total: number;
    ready: number;
    states: Record<string, string>;
  };
}

async function daemonJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await daemonRequest(path, init);
  if (!response.ok) throw new Error(`daemon returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

async function loadDevices(): Promise<AdbDevice[]> {
  const inventory = await daemonJson<{
    devices: Array<{
      serial: string;
      transportState: AdbDevice["transportState"];
      identity?: { model?: string };
    }>;
  }>("/devices");
  return inventory.devices.map((device) => ({
    serial: device.serial,
    transportState: device.transportState,
    ...(device.identity?.model ? { model: device.identity.model } : {}),
  }));
}

async function createRun(
  task: string,
  mode: RunMode = "independent",
  budget?: RunBudget,
  target?: { group?: string; deviceIds?: readonly string[] },
  retainScreenshots?: boolean,
): Promise<RunState> {
  const result = await daemonJson<{ run: RunState }>("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      task,
      mode,
      ...(budget ? { budget } : {}),
      ...target,
      ...(retainScreenshots === undefined ? {} : { retainScreenshots }),
    }),
  });
  return result.run;
}

async function listRuns(): Promise<RunState[]> {
  return (await daemonJson<{ runs: RunState[] }>("/runs")).runs;
}

function printRuns(runs: readonly RunState[]): void {
  if (runs.length === 0) {
    process.stdout.write("No runs yet.\n");
    return;
  }
  for (const run of runs) {
    const target = run.affinity?.group ?? (run.affinity ? run.affinity.deviceIds.join(",") : "all");
    process.stdout.write(`${run.id}\t${run.status}\t${run.mode}\t${target}\t${run.task}\n`);
  }
}

function formatRunEvent(event: RunEvent): string {
  if (event.type !== "run.trace") return event.type;
  const trace = event.trace;
  if (trace.phase === "observation") {
    return `OBSERVE ${trace.deviceId} ${trace.foregroundPackage ?? "unknown"} ${trace.generation.slice(0, 12)}`;
  }
  if (trace.phase === "decision") {
    return `DECIDE ${trace.deviceId} #${trace.decisionNumber} ${trace.decisionType} ${trace.actionCount} actions`;
  }
  return `ACT ${trace.deviceId} ${trace.requestId} ${trace.steps.map((step) => `${step.actionType}:${step.status}`).join(", ")}`;
}

async function showRun(id: string): Promise<void> {
  const [{ run }, { events }, { questions }, { approvals }, { artifacts }, { telemetry }] =
    await Promise.all([
      daemonJson<{ run: RunState }>(`/runs/${encodeURIComponent(id)}`),
      daemonJson<{ events: Array<{ sequence: number; event: RunEvent }> }>(
        `/runs/${encodeURIComponent(id)}/events`,
      ),
      daemonJson<{
        questions: Array<{ id: string; prompt: string; status: string; sensitive?: boolean }>;
      }>(`/runs/${encodeURIComponent(id)}/questions`),
      daemonJson<{
        approvals: Array<{ id: string; prompt: string; status: string; answer?: string }>;
      }>(`/runs/${encodeURIComponent(id)}/approvals`),
      daemonJson<{
        artifacts: Array<{ id: string; name: string; kind: string; bytes: number }>;
      }>(`/runs/${encodeURIComponent(id)}/artifacts`),
      daemonJson<{ telemetry: RunTelemetry | null }>(`/runs/${encodeURIComponent(id)}/telemetry`),
    ]);
  const target = run.affinity?.group ?? (run.affinity ? run.affinity.deviceIds.join(", ") : "all");
  process.stdout.write(`${run.id} · ${run.status} · ${run.mode} · ${target}\n${run.task}\n`);
  for (const item of events)
    process.stdout.write(`  ${item.sequence}  ${formatRunEvent(item.event)}\n`);
  for (const question of questions) {
    process.stdout.write(
      `  question ${question.id}  ${question.status}  ${question.prompt}${question.sensitive ? " [sensitive answer]" : ""}\n`,
    );
  }
  for (const approval of approvals) {
    process.stdout.write(
      `  approval ${approval.id}  ${approval.status}  ${approval.prompt}${approval.answer ? ` [${approval.answer}]` : ""}\n`,
    );
  }
  for (const artifact of artifacts) {
    process.stdout.write(
      `  artifact ${artifact.id}  ${artifact.kind}  ${artifact.bytes} bytes  ${artifact.name}\n`,
    );
  }
  if (telemetry) {
    process.stdout.write(
      `  telemetry  ${telemetry.modelCalls} model / ${telemetry.decisionCalls} decisions / ${telemetry.inputTokens + telemetry.outputTokens} tokens / ${telemetry.attemptedActions} actions / ${telemetry.elapsedMs}ms\n`,
    );
  }
}

async function answerQuestion(args: readonly string[]): Promise<void> {
  const command = parseAnswerCommand(args);
  await daemonJson(
    `/runs/${encodeURIComponent(command.runId)}/questions/${encodeURIComponent(command.questionId)}/answer`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: command.answer, sensitive: command.sensitive }),
    },
  );
  process.stdout.write(`Answered ${command.questionId}; run ${command.runId} resumed.\n`);
}

async function resolveApproval(decision: "approved" | "denied", args: readonly string[]) {
  const [runId, approvalId] = args;
  if (!runId || !approvalId)
    throw new Error(
      `${decision === "approved" ? "approve" : "deny"} requires a run ID and approval ID`,
    );
  await daemonJson(
    `/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    },
  );
  process.stdout.write(`${decision === "approved" ? "Approved" : "Denied"} ${approvalId}.\n`);
}

async function controlRun(operation: "pause" | "resume" | "stop" | "retry", runId?: string) {
  if (!runId) throw new Error(`${operation} requires a run ID`);
  const result = await daemonJson<{ run: RunState }>(
    `/runs/${encodeURIComponent(runId)}/${operation}`,
    { method: "POST" },
  );
  process.stdout.write(
    operation === "retry"
      ? `Retry created ${result.run.id}.\n`
      : `${operation[0]?.toUpperCase()}${operation.slice(1)} requested for ${runId}.\n`,
  );
}

async function interactiveSession(): Promise<void> {
  const devices = await loadDevices();
  process.stdout.write(
    `TapRig · ${devices.length} device${devices.length === 1 ? "" : "s"} connected\n` +
      "Type a task, or /mode, /group, /devices, /runs, /attach, /replay, /answer, /pause, /resume, /stop, /retry, /quit.\n\n",
  );
  let mode: RunMode = "independent";
  let group: string | undefined;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const line = (await terminal.question("› ")).trim();
      if (!line) continue;
      if (line === "/quit" || line === "/exit") return;
      if (line === "/devices") {
        process.stdout.write(`${formatAdbDevices(await loadDevices())}\n`);
        continue;
      }
      if (line === "/runs") {
        printRuns(await listRuns());
        continue;
      }
      if (line === "/mode") {
        process.stdout.write(`Run mode is ${mode}.\n`);
        continue;
      }
      if (line.startsWith("/mode ")) {
        try {
          mode = parseRunMode(line.slice(6).trim());
          process.stdout.write(`Run mode set to ${mode}.\n`);
        } catch (error) {
          process.stdout.write(`${error instanceof Error ? error.message : String(error)}.\n`);
        }
        continue;
      }
      if (line === "/group") {
        process.stdout.write(`Device group is ${group ?? "all ready devices"}.\n`);
        continue;
      }
      if (line.startsWith("/group ")) {
        const selected = line.slice(7).trim();
        group = selected === "off" ? undefined : selected;
        process.stdout.write(`Device group set to ${group ?? "all ready devices"}.\n`);
        continue;
      }
      if (line.startsWith("/attach ")) {
        await showRun(line.slice(8).trim());
        continue;
      }
      if (line.startsWith("/replay ")) {
        await showRun(line.slice(8).trim());
        continue;
      }
      if (line.startsWith("/answer ")) {
        await answerQuestion(line.slice(8).trim().split(/\s+/u));
        continue;
      }
      if (line.startsWith("/approve ") || line.startsWith("/deny ")) {
        const approved = line.startsWith("/approve ");
        await resolveApproval(
          approved ? "approved" : "denied",
          line
            .slice(approved ? 9 : 6)
            .trim()
            .split(/\s+/u),
        );
        continue;
      }
      if (/^\/(?:pause|resume|stop|retry)\s+/u.test(line)) {
        const [operation, runId] = line.slice(1).split(/\s+/u);
        await controlRun(operation as "pause" | "resume" | "stop" | "retry", runId);
        continue;
      }
      if (line.startsWith("/")) {
        process.stdout.write("Unknown command.\n");
        continue;
      }
      const run = await createRun(line, mode, undefined, group ? { group } : undefined);
      process.stdout.write(`Created ${run.id}. Use /attach ${run.id} to inspect it.\n`);
    }
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command && process.stdin.isTTY) {
    await interactiveSession();
    return;
  }
  const selectedCommand = command ?? "devices";
  if (selectedCommand === "mcp") {
    serveTapRigMcp();
    return;
  }
  if (selectedCommand === "onboard" || selectedCommand === "setup") {
    if (!(await daemonStatus())) {
      process.stdout.write("[..] Starting local daemon\n");
      await startDaemonProcess();
    }
    const setup = await daemonJson<SetupStatus>("/setup");
    process.stdout.write("\nTapRig setup\n\n[ok] Local daemon is online\n");
    process.stdout.write(
      setup.devices.total > 0
        ? `[ok] ${setup.devices.total} Android phone${setup.devices.total === 1 ? "" : "s"} detected\n`
        : "[  ] Android phone detected — connect USB, unlock it, enable USB debugging, and accept the trust prompt\n",
    );
    process.stdout.write(
      setup.devices.ready > 0
        ? `[ok] ${setup.devices.ready} phone${setup.devices.ready === 1 ? " is" : "s are"} ready\n`
        : `[  ] Phone ready — run taprig doctor${
            setup.devices.total > 0
              ? ` (${Object.entries(setup.devices.states)
                  .map(([serial, state]) => `${serial}: ${state}`)
                  .join(", ")})`
              : ""
          }\n`,
    );
    process.stdout.write(
      setup.agentConfigured
        ? `[ok] Agent is configured (${setup.modelProfile ?? "default"} profile)\n`
        : `[  ] Agent configured — set ${setup.modelKeyEnv ?? "the provider API key"} in the daemon environment, then restart it\n`,
    );
    process.stdout.write(
      setup.hasRuns ? "[ok] First run created\n" : '[  ] First run — taprig run "Open Settings"\n',
    );
    process.stdout.write(
      setup.status === "ready"
        ? "\nReady. Run taprig ui or type taprig for the interactive shell.\n"
        : "\nComplete the unchecked steps, then run taprig onboard again.\n",
    );
    return;
  }
  if (selectedCommand === "daemon") {
    const operation = process.argv[3] ?? "status";
    if (operation === "serve") {
      await serveDaemon();
      return;
    }
    if (operation === "start") {
      const state = await startDaemonProcess();
      process.stdout.write(`TapRig daemon running at ${state.url} (PID ${state.pid}).\n`);
      return;
    }
    if (operation === "stop") {
      process.stdout.write(
        (await stopDaemonProcess())
          ? "TapRig daemon stopped.\n"
          : "TapRig daemon is not running.\n",
      );
      return;
    }
    if (operation === "status") {
      const state = await daemonStatus();
      process.stdout.write(
        state
          ? `TapRig daemon running at ${state.url} (PID ${state.pid}).\n`
          : "TapRig daemon is not running.\n",
      );
      return;
    }
    throw new Error(`unknown daemon command: ${operation}`);
  }
  if (selectedCommand === "model") {
    const operation = process.argv[3] ?? "show";
    const config = loadOrCreateModelConfig();
    if (operation === "show") {
      const profile = config.profiles[config.selectedProfile];
      process.stdout.write(`Profile: ${config.selectedProfile}\n`);
      for (const role of ["fast", "strong", "vision"] as const) {
        const selected = profile.roles[role];
        process.stdout.write(`${role}: ${selected.provider}/${selected.model}\n`);
      }
      for (const [name, provider] of Object.entries(config.providers)) {
        process.stdout.write(
          `${name}: ${process.env[provider.apiKeyEnv] ? "configured" : `missing ${provider.apiKeyEnv}`}\n`,
        );
      }
      return;
    }
    if (operation === "profile") {
      const profile = process.argv[4] as ModelProfileName | undefined;
      if (!profile || !(["economy", "balanced", "best"] as const).includes(profile)) {
        throw new Error("model profile must be economy, balanced, or best");
      }
      config.selectedProfile = profile;
      saveModelConfig(config);
      process.stdout.write(`Model profile set to ${profile}.\n`);
      return;
    }
    if (operation === "set") {
      const profile = process.argv[4] as ModelProfileName | undefined;
      const role = process.argv[5] as ModelRole | undefined;
      const model = process.argv[6];
      const provider = process.argv[7] ?? "openai";
      if (!profile || !(["economy", "balanced", "best"] as const).includes(profile)) {
        throw new Error("model set requires an economy, balanced, or best profile");
      }
      if (!role || !(["fast", "strong", "vision"] as const).includes(role) || !model) {
        throw new Error("model set requires a fast, strong, or vision role and model ID");
      }
      if (!config.providers[provider]) throw new Error(`unknown model provider: ${provider}`);
      config.profiles[profile].roles[role] = { provider, model };
      saveModelConfig(config);
      process.stdout.write(`${profile}/${role} set to ${provider}/${model}.\n`);
      return;
    }
    throw new Error(`unknown model command: ${operation}`);
  }
  if (selectedCommand === "settings") {
    const operation = process.argv[3] ?? "show";
    if (operation === "show") {
      const { settings } = await daemonJson<{ settings: TapRigSettings }>("/settings");
      process.stdout.write(
        `Approval policy: ${settings.approvalPolicy}\nRetain terminal screenshots by default: ${settings.retainScreenshotsByDefault ? "yes" : "no"}\n`,
      );
      return;
    }
    const value = process.argv[4];
    const patch =
      operation === "approval" && (value === "autonomous" || value === "explicit")
        ? { approvalPolicy: value }
        : operation === "screenshots" && (value === "on" || value === "off")
          ? { retainScreenshotsByDefault: value === "on" }
          : undefined;
    if (!patch) {
      throw new Error(
        "settings requires show, approval autonomous|explicit, or screenshots on|off",
      );
    }
    const { settings } = await daemonJson<{ settings: TapRigSettings }>("/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    process.stdout.write(
      `Settings saved: ${settings.approvalPolicy}, screenshots ${settings.retainScreenshotsByDefault ? "on" : "off"}.\n`,
    );
    return;
  }
  if (selectedCommand === "script") {
    const operation = process.argv[3] ?? "list";
    if (operation === "list") {
      const { scripts } = await daemonJson<{ scripts: TapRigScript[] }>("/scripts");
      if (scripts.length === 0) process.stdout.write("No scripts yet.\n");
      for (const script of scripts) {
        process.stdout.write(`${script.id}\tv${script.version}\t${script.name}\n`);
      }
      return;
    }
    if (operation === "inspect") {
      const id = process.argv[4];
      if (!id) throw new Error("script inspect requires a script ID");
      const result = await daemonJson<{ script: TapRigScript }>(
        `/scripts/${encodeURIComponent(id)}`,
      );
      process.stdout.write(`${JSON.stringify(result.script, null, 2)}\n`);
      return;
    }
    if (operation === "create") {
      const path = process.argv[4];
      if (!path) throw new Error("script create requires a JSON file path");
      const result = await daemonJson<{ script: TapRigScript }>("/scripts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: readFileSync(path, "utf8"),
      });
      process.stdout.write(`Saved ${result.script.id} v${result.script.version}.\n`);
      return;
    }
    if (operation === "run") {
      const id = process.argv[4];
      const deviceId = process.argv[5];
      if (!id || !deviceId) throw new Error("script run requires a script ID and device ID");
      const inputs = Object.fromEntries(
        process.argv.slice(6).map((argument) => {
          const separator = argument.indexOf("=");
          if (separator < 1) throw new Error("script inputs must use name=value");
          return [argument.slice(0, separator), argument.slice(separator + 1)];
        }),
      );
      const response = await daemonJson<{ result: ScriptRunResult; recoveryRun?: RunState }>(
        `/scripts/${encodeURIComponent(id)}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceId, inputs }),
        },
      );
      process.stdout.write(`${JSON.stringify(response)}\n`);
      if (response.result.status === "recovery-needed" && !response.recoveryRun)
        process.exitCode = 2;
      return;
    }
    if (operation === "promote") {
      const runId = process.argv[4];
      const id = process.argv[5];
      const name = process.argv.slice(6).join(" ").trim();
      if (!runId || !id || !name) {
        throw new Error("script promote requires a run ID, script ID, and name");
      }
      const { script } = await daemonJson<{ script: TapRigScript }>(
        `/runs/${encodeURIComponent(runId)}/promote`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, name }),
        },
      );
      process.stdout.write(`Promoted ${runId} to ${script.id} v${script.version}.\n`);
      return;
    }
    throw new Error(`unknown script command: ${operation}`);
  }
  if (selectedCommand === "group") {
    const operation = process.argv[3] ?? "list";
    if (operation === "list") {
      const { groups } = await daemonJson<{
        groups: Array<{ name: string; deviceIds: readonly string[] }>;
      }>("/device-groups");
      if (groups.length === 0) process.stdout.write("No device groups yet.\n");
      else {
        for (const group of groups)
          process.stdout.write(`${group.name}\t${group.deviceIds.join(",")}\n`);
      }
      return;
    }
    const name = process.argv[4];
    if (!name) throw new Error(`group ${operation} requires a name`);
    if (operation === "set") {
      const deviceIds = process.argv.slice(5);
      const { group } = await daemonJson<{ group: { name: string; deviceIds: string[] } }>(
        `/device-groups/${encodeURIComponent(name)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deviceIds }),
        },
      );
      process.stdout.write(`Saved ${group.name}: ${group.deviceIds.join(", ")}\n`);
      return;
    }
    if (operation === "delete") {
      const response = await daemonRequest(`/device-groups/${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`daemon returned HTTP ${response.status}`);
      process.stdout.write(`Deleted ${name}.\n`);
      return;
    }
    throw new Error(`unknown group command: ${operation}`);
  }
  if (selectedCommand === "ui") {
    const { url } = await daemonJson<{ url: string }>("/browser-sessions", { method: "POST" });
    process.stdout.write(`${url}\n`);
    return;
  }
  if (selectedCommand === "execute") {
    const execution = parseExecuteCommand(process.argv.slice(3));
    const response = await daemonRequest(
      `/devices/${encodeURIComponent(execution.serial)}/actions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: execution.action }),
      },
    );
    if (!response.ok) throw new Error(`daemon rejected action with HTTP ${response.status}`);
    process.stdout.write(`Action sent to ${execution.serial}; result not yet verified.\n`);
    return;
  }
  if (selectedCommand === "run") {
    const command = parseRunCommand(process.argv.slice(3));
    const run = await createRun(
      command.task,
      command.mode,
      command.budget,
      {
        ...(command.group ? { group: command.group } : {}),
        ...(command.deviceIds ? { deviceIds: command.deviceIds } : {}),
      },
      command.retainScreenshots,
    );
    process.stdout.write(`${run.id}\t${run.status}\n`);
    return;
  }
  if (selectedCommand === "runs") {
    printRuns(await listRuns());
    return;
  }
  if (selectedCommand === "attach" || selectedCommand === "replay") {
    const id = process.argv[3];
    if (!id) throw new Error(`${selectedCommand} requires a run ID`);
    await showRun(id);
    return;
  }
  if (selectedCommand === "answer") {
    await answerQuestion(process.argv.slice(3));
    return;
  }
  if (selectedCommand === "approve" || selectedCommand === "deny") {
    await resolveApproval(
      selectedCommand === "approve" ? "approved" : "denied",
      process.argv.slice(3),
    );
    return;
  }
  if (
    selectedCommand === "pause" ||
    selectedCommand === "resume" ||
    selectedCommand === "stop" ||
    selectedCommand === "retry"
  ) {
    await controlRun(selectedCommand, process.argv[3]);
    return;
  }
  if (selectedCommand === "artifacts") {
    const runId = process.argv[3];
    if (!runId) throw new Error("artifacts requires a run ID");
    const { artifacts } = await daemonJson<{
      artifacts: Array<{ id: string; kind: string; bytes: number; name: string }>;
    }>(`/runs/${encodeURIComponent(runId)}/artifacts`);
    if (artifacts.length === 0) process.stdout.write("No artifacts.\n");
    for (const artifact of artifacts) {
      process.stdout.write(
        `${artifact.id}\t${artifact.kind}\t${artifact.bytes}\t${artifact.name}\n`,
      );
    }
    return;
  }
  if (selectedCommand === "export") {
    const runId = process.argv[3];
    if (!runId) throw new Error("export requires a run ID");
    const output = process.argv[4] ?? `taprig-${runId}.json`;
    const response = await daemonRequest(`/runs/${encodeURIComponent(runId)}/export`);
    if (!response.ok) throw new Error(`daemon returned HTTP ${response.status}`);
    writeFileSync(output, Buffer.from(await response.arrayBuffer()), { flag: "wx", mode: 0o600 });
    process.stdout.write(`Exported ${runId} to ${output}.\n`);
    return;
  }

  const devices = await loadDevices();
  if (selectedCommand === "devices") {
    process.stdout.write(`${formatAdbDevices(devices)}\n`);
    return;
  }
  if (selectedCommand === "doctor") {
    const findings = diagnoseAdbDevices(devices);
    process.stdout.write(`${formatDoctorFindings(findings)}\n`);
    if (findings.some(({ status }) => status === "fail")) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command: ${selectedCommand}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`TapRig: ${message}\n`);
  process.exitCode = 1;
});
