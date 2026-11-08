import type { AgentContext, AgentDecision } from "../agents/loop.ts";
import { runAgentLoop } from "../agents/loop.ts";
import type {
  ActionStep,
  DeviceAdapter,
  DeviceCapability,
  RunTelemetry,
  RunTrace,
} from "../core/contracts.ts";
import { BudgetExceededError } from "../core/errors.ts";
import type { DeviceInventory } from "../daemon/server.ts";
import type { RecordModelUsage } from "../models/usage.ts";
import { runBroadcast } from "../orchestration/broadcast.ts";
import type {
  CoordinatedNode,
  CoordinatedNodeResult,
  CoordinatedPlan,
} from "../orchestration/coordinated.ts";
import { runCoordinated } from "../orchestration/coordinated.ts";
import type { RunService } from "./service.ts";

export interface RunWorkerOptions {
  runs: RunService;
  devices: DeviceInventory;
  adapter: DeviceAdapter;
  decide(task: string, recordUsage?: RecordModelUsage): Decider;
  planCoordinated?(task: string, recordUsage?: RecordModelUsage): Promise<CoordinatedPlan>;
  captureArtifact?(runId: string, deviceId: string): Promise<void>;
  /** Wakes a locked phone and refreshes inventory so a sleeping screen does not fail a run. */
  wake?(deviceId: string): Promise<void>;
  /** Runs once a phone is leased, before the first observation: rotation lock and similar. */
  prepare?(deviceId: string): Promise<void>;
  /** Starts recording a leased phone; the returned function stops it and files the artifact. */
  record?(runId: string, deviceId: string): Promise<() => Promise<void>>;
  /** Runs after a failed or stopped run so the next one starts from a known screen (home). */
  cleanup?(deviceId: string): Promise<void>;
  /** Named secrets a task references as {{secret:NAME}}; resolved only on the way to the phone. */
  secrets?: { resolve(text: string): string; referenced(text: string): string[] };
}

type Decider = (context: AgentContext) => Promise<AgentDecision>;

const agentCapabilities = ["semantic-observation", "semantic-action"] as const;

export interface RunAnswer {
  prompt: string;
  value: string;
  sensitive: boolean;
  kind?: "question" | "approval";
  deviceId?: string;
  deviceIds?: readonly string[];
}

interface RunRecovery {
  deviceIds?: string[];
  batches?: Record<
    string,
    { requestId: string; steps: Array<{ stepId: string; status: string; actionType?: string }> }
  >;
  plan?: CoordinatedPlan;
  nodes?: CoordinatedNodeResult[];
}

/** What the model types to use a sensitive answer it is never shown. */
export const secretPlaceholder = "[SECRET]";

function answerNote(answer: RunAnswer): string {
  const verb = answer.kind === "approval" ? "resolved the approval" : "answered";
  if (!answer.sensitive) return `\n\nThe user ${verb} "${answer.prompt}": ${answer.value}`;
  return `\n\nThe user ${verb} "${answer.prompt}" with a secret you cannot see. To enter it, use a text action with input exactly ${secretPlaceholder}; never guess it and never mention it in evidence.`;
}

function revealSecrets<T extends { steps: readonly ActionStep[] }>(
  batch: T,
  answerSecret: string | undefined,
  resolve: ((text: string) => string) | undefined,
): T {
  return {
    ...batch,
    steps: batch.steps.map((step) => {
      if (step.action.type !== "element.text") return step;
      let value = step.action.value;
      if (answerSecret !== undefined) value = value.replaceAll(secretPlaceholder, answerSecret);
      if (resolve) value = resolve(value);
      return value === step.action.value ? step : { ...step, action: { ...step.action, value } };
    }),
  };
}

function readRecovery(value: unknown): RunRecovery {
  return value && typeof value === "object" ? (value as RunRecovery) : {};
}

function redact<T>(value: T, secrets: readonly string[]): T {
  const known = secrets.flatMap((secret) => [secret, secret.trim()]).filter(Boolean);
  if (known.length === 0) return value;
  if (typeof value === "string") {
    let text: string = value;
    for (const candidate of new Set(known)) text = text.replaceAll(candidate, "[REDACTED]");
    return text as T;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]),
    ) as T;
  }
  return value;
}

function metric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readTelemetry(value: unknown): RunTelemetry {
  const stored = value && typeof value === "object" ? (value as Partial<RunTelemetry>) : {};
  return {
    executions: metric(stored.executions),
    elapsedMs: metric(stored.elapsedMs),
    decisionCalls: metric(stored.decisionCalls),
    modelCalls: metric(stored.modelCalls),
    inputTokens: metric(stored.inputTokens),
    outputTokens: metric(stored.outputTokens),
    costUsd: metric(stored.costUsd),
    attemptedActions: metric(stored.attemptedActions),
  };
}

class RunInterruptedError extends Error {}

export class RunWorker {
  readonly #active = new Map<string, Promise<void>>();
  readonly #leasedDevices = new Set<string>();

  /** Whether a run currently holds this phone. */
  busy(deviceId: string): boolean {
    return this.#leasedDevices.has(deviceId);
  }
  readonly #leaseWaiters = new Set<() => void>();
  readonly #runs: RunService;
  readonly #devices: DeviceInventory;
  readonly #adapter: DeviceAdapter;
  readonly #decide: (task: string, recordUsage?: RecordModelUsage) => Decider;
  readonly #planCoordinated:
    | ((task: string, recordUsage?: RecordModelUsage) => Promise<CoordinatedPlan>)
    | undefined;
  readonly #captureArtifact: ((runId: string, deviceId: string) => Promise<void>) | undefined;
  readonly #record: RunWorkerOptions["record"];
  readonly #cleanup: RunWorkerOptions["cleanup"];
  readonly #secrets: RunWorkerOptions["secrets"];
  readonly #wake: ((deviceId: string) => Promise<void>) | undefined;
  readonly #prepare: ((deviceId: string) => Promise<void>) | undefined;

  constructor(options: RunWorkerOptions) {
    this.#runs = options.runs;
    this.#devices = options.devices;
    this.#adapter = options.adapter;
    this.#decide = options.decide;
    this.#planCoordinated = options.planCoordinated;
    this.#captureArtifact = options.captureArtifact;
    this.#record = options.record;
    this.#cleanup = options.cleanup;
    this.#secrets = options.secrets;
    this.#wake = options.wake;
    this.#prepare = options.prepare;
  }

  start(runId: string, deviceId?: string): void {
    if (this.#active.has(runId)) return;
    this.#track(runId, this.#execute(runId, deviceId));
  }

  recover(runId: string): void {
    if (this.#active.has(runId)) return;
    this.#track(runId, this.#execute(runId, undefined, undefined, true));
  }

  resume(runId: string, answer: RunAnswer): void {
    const prior = this.#active.get(runId) ?? Promise.resolve();
    this.#track(
      runId,
      prior.then(() => this.#execute(runId, answer.deviceId, answer)),
    );
  }

  resumePaused(runId: string): void {
    const prior = this.#active.get(runId) ?? Promise.resolve();
    this.#track(
      runId,
      prior.then(() => this.#execute(runId, undefined, undefined, false, true)),
    );
  }

  async idle(): Promise<void> {
    while (this.#active.size > 0) await Promise.all(this.#active.values());
  }

  #track(runId: string, operation: Promise<void>): void {
    const tracked = operation.finally(() => {
      if (this.#active.get(runId) === tracked) this.#active.delete(runId);
    });
    this.#active.set(runId, tracked);
  }

  async #execute(
    runId: string,
    requestedDeviceId?: string,
    answer?: RunAnswer,
    recovering = false,
    continuing = false,
  ): Promise<void> {
    let run = this.#runs.get(runId);
    if (run?.status === "created" && !answer) {
      run = this.#runs.record(runId, { type: "run.started", at: new Date().toISOString() });
    } else if (run?.status === "waiting-for-user" && answer) {
      run = this.#runs.record(runId, { type: "run.resumed", at: new Date().toISOString() });
    } else if (run?.status === "running" && recovering) {
      run = this.#runs.record(runId, { type: "run.recovered", at: new Date().toISOString() });
    } else if (run?.status === "paused" && continuing) {
      run = this.#runs.record(runId, { type: "run.resumed", at: new Date().toISOString() });
    } else {
      return;
    }
    const recovery = readRecovery(this.#runs.recovery(runId)?.evidence);
    let task = answer ? `${run.task}${answerNote(answer)}` : run.task;
    if (recovering || continuing) {
      task +=
        `\n\nTapRig ${recovering ? "restarted" : "resumed after a user pause"} during this run. Inspect current phone state before acting. ` +
        "Do not repeat work unless current state proves it is still required.";
      if (recovery.batches) {
        task += `\nPreviously verified progress: ${JSON.stringify(recovery.batches)}`;
      }
    }
    const answerSecret = answer?.sensitive ? answer.value : undefined;
    const secret = [
      ...(answerSecret !== undefined ? [answerSecret] : []),
      ...(this.#secrets?.referenced(run.task) ?? []),
    ];
    const requireRunning = () => {
      const status = this.#runs.get(runId)?.status;
      if (status !== "running") throw new RunInterruptedError(`run is ${status ?? "missing"}`);
    };
    const saveRecovery = () => this.#runs.saveRecovery(runId, redact(recovery, secret));
    const trace = (entry: RunTrace) => {
      requireRunning();
      this.#runs.record(runId, { type: "run.trace", at: new Date().toISOString(), trace: entry });
    };
    const telemetry = readTelemetry(this.#runs.telemetry(runId)?.evidence);
    let reservedModelCalls = telemetry.modelCalls;
    const startedAt = performance.now();
    const reserveModelCall = () => {
      if (
        run.budget?.maxModelCalls !== undefined &&
        reservedModelCalls >= run.budget.maxModelCalls
      ) {
        throw new BudgetExceededError(`model-call budget of ${run.budget.maxModelCalls} exhausted`);
      }
      reservedModelCalls += 1;
    };
    const recordUsage: RecordModelUsage = (usage) => {
      telemetry.modelCalls += 1;
      telemetry.inputTokens += usage.inputTokens;
      telemetry.outputTokens += usage.outputTokens;
      telemetry.costUsd += usage.costUsd;
    };
    const device: DeviceAdapter = {
      observe: async (deviceId) => {
        requireRunning();
        const observation = await this.#adapter.observe(deviceId);
        requireRunning();
        trace({
          phase: "observation",
          deviceId,
          generation: observation.generation,
          ...(observation.foregroundPackage
            ? { foregroundPackage: observation.foregroundPackage }
            : {}),
        });
        return observation;
      },
      execute: async (batch) => {
        requireRunning();
        if (
          run.budget?.maxActions !== undefined &&
          telemetry.attemptedActions + batch.steps.length > run.budget.maxActions
        ) {
          throw new BudgetExceededError(`action budget of ${run.budget.maxActions} exhausted`);
        }
        telemetry.attemptedActions += batch.steps.length;
        const result = await this.#adapter.execute(
          revealSecrets(batch, answerSecret, this.#secrets?.resolve.bind(this.#secrets)),
        );
        recovery.batches ??= {};
        recovery.batches[batch.deviceId] = {
          requestId: batch.requestId,
          steps: result.steps.map((step, index) => ({
            stepId: step.stepId,
            status: step.status,
            ...(batch.steps[index] ? { actionType: batch.steps[index].action.type } : {}),
          })),
        };
        saveRecovery();
        requireRunning();
        trace({
          phase: "action",
          deviceId: batch.deviceId,
          requestId: batch.requestId,
          steps: batch.steps.map((step, index) => ({
            stepId: step.id,
            actionType: step.action.type,
            status: result.steps[index]?.status ?? "failed",
            // Codes only: messages can quote screen text the run must not retain.
            ...(result.steps[index]?.error ? { errorCode: result.steps[index].error.code } : {}),
          })),
        });
        return result;
      },
    };
    const decide = (work: string): Decider => {
      const selected = this.#decide(work, recordUsage);
      return async (context) => {
        requireRunning();
        reserveModelCall();
        telemetry.decisionCalls += 1;
        const decision = await selected(context);
        requireRunning();
        trace({
          phase: "decision",
          deviceId: context.observation.deviceId,
          decisionNumber: context.decisionNumber,
          decisionType: decision.type,
          actionCount: decision.type === "execute" ? decision.steps.length : 0,
        });
        return decision;
      };
    };
    let leasedDeviceIds: string[] = [];
    const recordings: Array<() => Promise<void>> = [];
    try {
      requireRunning();
      if (run.mode === "coordinated") {
        if (!this.#planCoordinated) throw new Error("coordinated planner is not configured");
        const previous = answer
          ? (this.#runs.completion(runId)?.evidence as
              | { plan?: CoordinatedPlan; nodes?: CoordinatedNodeResult[] }
              | undefined)
          : recovering || continuing
            ? recovery
            : undefined;
        if (!previous?.plan) reserveModelCall();
        const plan = previous?.plan ?? (await this.#planCoordinated(task, recordUsage));
        requireRunning();
        const initialResults = (previous?.nodes ?? []).filter(
          (node): node is Extract<CoordinatedNodeResult, { status: "completed" }> =>
            node.status === "completed",
        );
        const waiting = previous?.nodes?.find((node) => node.status === "waiting-for-user");
        recovery.plan = plan;
        recovery.nodes = [...initialResults];
        saveRecovery();
        const executionPlan = answer
          ? {
              nodes: plan.nodes.map((node) =>
                initialResults.some((result) => result.id === node.id)
                  ? node
                  : {
                      ...node,
                      task: `${node.task}${answerNote(answer)}`,
                      ...(waiting?.id === node.id && "deviceId" in waiting
                        ? { deviceId: waiting.deviceId }
                        : {}),
                    },
              ),
            }
          : plan;
        const result = redact(
          await runCoordinated({
            plan: executionPlan,
            initialResults,
            execute: (node, dependencies) =>
              this.#executeCoordinatedNode(
                node,
                dependencies.map(({ id, evidence }) => `${id}: ${evidence}`),
                device,
                decide,
                run.affinity?.deviceIds,
              ),
            onProgress: (nodes) => {
              recovery.nodes = [...nodes];
              saveRecovery();
            },
          }),
          secret,
        );
        requireRunning();
        const at = new Date().toISOString();
        const devices = result.nodes.flatMap((node) =>
          "deviceId" in node && node.deviceId ? [node.deviceId] : [],
        );
        this.#runs.checkpoint(runId, devices[0] ?? "coordinator", {
          summary: Object.fromEntries(
            result.nodes.flatMap((node) =>
              node.status === "completed" ? [[node.id, node.evidence]] : [],
            ),
          ),
          actions: result.nodes.flatMap((node) =>
            node.status === "completed" ? node.actions : [],
          ),
          devices: [...new Set(devices)],
          plan,
          nodes: result.nodes,
        });
        if (result.status === "completed") {
          this.#runs.record(runId, { type: "run.completed", at });
        } else if (result.status === "waiting-for-user") {
          const waiting = result.nodes.find((node) => node.status === "waiting-for-user");
          this.#runs[result.interaction === "approval" ? "approval" : "question"](
            runId,
            result.question,
            waiting && "deviceId" in waiting ? waiting.deviceId : undefined,
          );
          this.#runs.record(runId, { type: "run.waitingForUser", at });
        } else {
          this.#runs.record(runId, {
            type: "run.failed",
            at,
            error: { code: "verification-failed", message: result.reason, retryable: false },
          });
        }
        return;
      }
      leasedDeviceIds =
        run.mode === "broadcast"
          ? answer?.deviceIds
            ? await this.#acquireSpecificDevices(answer.deviceIds)
            : (recovering || continuing) && recovery.deviceIds
              ? await this.#acquireSpecificDevices(recovery.deviceIds)
              : run.affinity
                ? await this.#acquireSpecificDevices(run.affinity.deviceIds)
                : await this.#acquireBroadcastDevices()
          : [
              await this.#acquireDevice(
                requestedDeviceId ??
                  (recovering || continuing ? recovery.deviceIds?.[0] : undefined),
                agentCapabilities,
                run.affinity?.deviceIds,
              ),
            ];
      recovery.deviceIds = [...leasedDeviceIds];
      saveRecovery();
      if (this.#record) {
        for (const deviceId of leasedDeviceIds) {
          const stop = await this.#record(runId, deviceId).catch(() => undefined);
          if (stop) recordings.push(stop);
        }
      }
      const result = redact(
        run.mode === "broadcast"
          ? await runBroadcast({
              device,
              deviceIds: leasedDeviceIds,
              decide: decide(task),
              recover: (deviceId) =>
                runAgentLoop({
                  device,
                  deviceId,
                  decide: decide(task),
                  verifyCompletion: async () => undefined,
                }),
            })
          : await runAgentLoop({
              device,
              deviceId: leasedDeviceIds[0] as string,
              decide: decide(task),
              verifyCompletion: async () => undefined,
            }),
        secret,
      );
      requireRunning();
      const at = new Date().toISOString();
      if (result.status === "completed") {
        this.#runs.checkpoint(runId, leasedDeviceIds[0] as string, {
          summary: result.evidence,
          actions: result.actions,
          devices: leasedDeviceIds,
        });
        this.#runs.record(runId, { type: "run.completed", at });
      } else if (result.status === "waiting-for-user") {
        this.#runs[result.interaction === "approval" ? "approval" : "question"](
          runId,
          result.question,
          leasedDeviceIds[0],
          run.mode === "broadcast" ? leasedDeviceIds : undefined,
        );
        this.#runs.record(runId, { type: "run.waitingForUser", at });
      } else {
        this.#runs.record(runId, {
          type: "run.failed",
          at,
          error: { code: "verification-failed", message: result.reason, retryable: false },
        });
      }
    } catch (error) {
      const status = this.#runs.get(runId)?.status;
      if (error instanceof RunInterruptedError || status === "paused" || status === "stopped")
        return;
      const budgetExceeded = error instanceof BudgetExceededError;
      this.#runs.record(runId, {
        type: "run.failed",
        at: new Date().toISOString(),
        error: {
          code: budgetExceeded ? "budget-exhausted" : "transport-failed",
          message: redact(error instanceof Error ? error.message : String(error), secret),
          retryable: !budgetExceeded,
        },
      });
    } finally {
      for (const stop of recordings) await stop().catch(() => undefined);
      const terminal = this.#runs.get(runId)?.status;
      if (
        run.retainScreenshots &&
        this.#captureArtifact &&
        (terminal === "completed" || terminal === "failed")
      ) {
        const coordinated = (recovery.nodes ?? []).flatMap((node) =>
          "deviceId" in node && node.deviceId ? [node.deviceId] : [],
        );
        for (const deviceId of new Set([
          ...leasedDeviceIds,
          ...(recovery.deviceIds ?? []),
          ...coordinated,
        ])) {
          await this.#captureArtifact(runId, deviceId).catch(() => undefined);
        }
      }
      if (this.#cleanup && (terminal === "failed" || terminal === "stopped")) {
        for (const deviceId of leasedDeviceIds)
          await this.#cleanup(deviceId).catch(() => undefined);
      }
      for (const deviceId of leasedDeviceIds) this.#releaseDevice(deviceId);
      telemetry.executions += 1;
      telemetry.elapsedMs =
        Math.round((telemetry.elapsedMs + performance.now() - startedAt) * 1000) / 1000;
      this.#runs.saveTelemetry(runId, telemetry);
    }
  }

  async #executeCoordinatedNode(
    node: CoordinatedNode,
    dependencies: readonly string[],
    device: DeviceAdapter,
    decide: (task: string) => Decider,
    allowedDeviceIds?: readonly string[],
  ): Promise<CoordinatedNodeResult> {
    let deviceId: string | undefined;
    try {
      deviceId = await this.#acquireDevice(
        node.deviceId,
        node.capabilities ?? agentCapabilities,
        allowedDeviceIds,
      );
      const result = await runAgentLoop({
        device,
        deviceId,
        decide: decide(
          dependencies.length > 0
            ? `${node.task}\n\nVerified dependency results:\n${dependencies.join("\n")}`
            : node.task,
        ),
        verifyCompletion: async () => undefined,
      });
      if (result.status === "completed") {
        return {
          id: node.id,
          status: "completed",
          deviceId,
          evidence: result.evidence,
          actions: result.actions,
        };
      }
      if (result.status === "waiting-for-user") {
        return {
          id: node.id,
          status: "waiting-for-user",
          deviceId,
          interaction: result.interaction,
          question: result.question,
        };
      }
      return { id: node.id, status: "failed", deviceId, reason: result.reason };
    } finally {
      if (deviceId) this.#releaseDevice(deviceId);
    }
  }

  async #acquireDevice(
    requestedDeviceId?: string,
    capabilities: readonly DeviceCapability[] = agentCapabilities,
    allowedDeviceIds?: readonly string[],
  ): Promise<string> {
    if (requestedDeviceId && allowedDeviceIds && !allowedDeviceIds.includes(requestedDeviceId)) {
      throw new Error(`requested Android device ${requestedDeviceId} is outside the run affinity`);
    }
    let woke = false;
    while (true) {
      const listed = await this.#devices.list();
      const allReady = listed
        .filter((candidate) => candidate.state === "ready")
        .sort((left, right) => left.id.localeCompare(right.id));
      const locked = listed.filter((candidate) => candidate.state === "locked");
      if (allReady.length === 0 && locked.length > 0 && this.#wake && !woke) {
        woke = true;
        const outcomes = await Promise.allSettled(
          locked.map((candidate) => this.#wake?.(candidate.id)),
        );
        for (const outcome of outcomes) {
          if (outcome.status === "rejected")
            console.error(`[taprig] unlock failed: ${String(outcome.reason)}`);
        }
        continue;
      }
      if (allReady.length === 0) {
        throw new Error(
          locked.length > 0
            ? "the connected phone is locked; unlock it, or start the daemon with TAPRIG_UNLOCK_PIN set"
            : "no ready Android device is connected",
        );
      }
      const ready = allowedDeviceIds
        ? allReady.filter((candidate) => allowedDeviceIds.includes(candidate.id))
        : allReady;
      if (ready.length === 0) throw new Error("no Android device in the run affinity is ready");
      const eligible = ready.filter((candidate) =>
        capabilities.every((capability) => candidate.capabilities?.includes(capability)),
      );
      const device = requestedDeviceId
        ? eligible.find(
            (candidate) =>
              candidate.id === requestedDeviceId && !this.#leasedDevices.has(candidate.id),
          )
        : eligible.find((candidate) => !this.#leasedDevices.has(candidate.id));
      if (device) {
        this.#leasedDevices.add(device.id);
        // A failed rotation lock is logged, not fatal: the run still has a phone.
        await this.#prepare?.(device.id).catch((error: unknown) => {
          console.error(
            `prepare ${device.id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        return device.id;
      }
      if (requestedDeviceId && !ready.some((candidate) => candidate.id === requestedDeviceId)) {
        throw new Error(`requested Android device ${requestedDeviceId} is not ready`);
      }
      if (requestedDeviceId && !eligible.some((candidate) => candidate.id === requestedDeviceId)) {
        throw new Error(
          `requested Android device ${requestedDeviceId} does not support ${capabilities.join(", ")}`,
        );
      }
      if (eligible.length === 0) {
        throw new Error(`no ready Android device supports ${capabilities.join(", ")}`);
      }
      await new Promise<void>((resolve) => this.#leaseWaiters.add(resolve));
    }
  }

  async #acquireBroadcastDevices(): Promise<string[]> {
    while (true) {
      const ready = (await this.#devices.list())
        .filter((candidate) => candidate.state === "ready")
        .filter((candidate) =>
          agentCapabilities.every((capability) => candidate.capabilities?.includes(capability)),
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      if (ready.length < 2)
        throw new Error("broadcast requires at least two ready Android devices");
      if (ready.every((candidate) => !this.#leasedDevices.has(candidate.id))) {
        for (const device of ready) this.#leasedDevices.add(device.id);
        await Promise.allSettled(ready.map((device) => this.#prepare?.(device.id)));
        return ready.map((device) => device.id);
      }
      await new Promise<void>((resolve) => this.#leaseWaiters.add(resolve));
    }
  }

  async #acquireSpecificDevices(deviceIds: readonly string[]): Promise<string[]> {
    const requested = [...new Set(deviceIds)].sort();
    if (requested.length < 2) throw new Error("broadcast requires at least two devices");
    while (true) {
      const ready = (await this.#devices.list())
        .filter((candidate) => candidate.state === "ready")
        .filter((candidate) =>
          agentCapabilities.every((capability) => candidate.capabilities?.includes(capability)),
        );
      const missing = requested.find((id) => !ready.some((candidate) => candidate.id === id));
      if (missing) throw new Error(`broadcast Android device ${missing} is not ready`);
      if (requested.every((id) => !this.#leasedDevices.has(id))) {
        for (const id of requested) this.#leasedDevices.add(id);
        await Promise.allSettled(requested.map((id) => this.#prepare?.(id)));
        return requested;
      }
      await new Promise<void>((resolve) => this.#leaseWaiters.add(resolve));
    }
  }

  #releaseDevice(deviceId: string): void {
    this.#leasedDevices.delete(deviceId);
    for (const resolve of this.#leaseWaiters) resolve();
    this.#leaseWaiters.clear();
  }
}
