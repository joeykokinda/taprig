export type DeviceId = string;
export type RunId = string;

export type DeviceState = "unauthorized" | "offline" | "booting" | "locked" | "degraded" | "ready";

export type DeviceCapability =
  | "semantic-observation"
  | "semantic-action"
  | "raw-input"
  | "video"
  | "screenshot"
  | "shell";

export interface Device {
  id: DeviceId;
  serial: string;
  label: string;
  state: DeviceState;
  capabilities: readonly DeviceCapability[];
}

export interface Element {
  id: string;
  role: string;
  text?: string;
  description?: string;
  resourceId?: string;
  actionable: boolean;
}

export interface Observation {
  deviceId: DeviceId;
  generation: string;
  foregroundPackage?: string;
  elements: readonly Element[];
  capturedAt: string;
}

export type Selector =
  | { elementId: string }
  | { resourceId: string }
  | { description: string }
  | { text: string; role?: string };

export type Action =
  | { type: "app.launch"; packageName: string }
  | { type: "element.tap"; target: Selector }
  | { type: "element.longTap"; target: Selector }
  | { type: "element.text"; target: Selector; value: string; clear?: boolean }
  | { type: "key.press"; key: "back" | "home" | "recents" | "enter" | "delete" }
  | { type: "gesture.tap"; x: number; y: number }
  | {
      type: "gesture.swipe";
      from: { x: number; y: number };
      to: { x: number; y: number };
      durationMs: number;
    };

export interface ActionStep {
  id: string;
  action: Action;
}

export interface ActionBatch {
  requestId: string;
  deviceId: DeviceId;
  observationGeneration: string;
  steps: readonly ActionStep[];
}

export type StepStatus = "verified" | "failed" | "skipped";

export interface StepResult {
  stepId: string;
  status: StepStatus;
  durationMs: number;
  error?: TapRigError;
}

export interface BatchResult {
  requestId: string;
  deviceId: DeviceId;
  steps: readonly StepResult[];
  replayed: boolean;
}

export type ErrorCode =
  | "device-not-ready"
  | "stale-observation"
  | "ambiguous-selector"
  | "target-not-found"
  | "unsupported-action"
  | "verification-failed"
  | "transport-failed";

export interface TapRigError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface DeviceAdapter {
  observe(deviceId: DeviceId): Promise<Observation>;
  execute(batch: ActionBatch): Promise<BatchResult>;
}

export type RunMode = "independent" | "broadcast" | "coordinated";
export type RunStatus =
  | "created"
  | "running"
  | "paused"
  | "waiting-for-user"
  | "completed"
  | "failed"
  | "stopped";

export interface RunState {
  id: RunId;
  mode: RunMode;
  task: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  error?: TapRigError;
}

export type RunEvent =
  | { type: "run.created"; run: RunState }
  | { type: "run.started"; at: string }
  | { type: "run.paused"; at: string }
  | { type: "run.resumed"; at: string }
  | { type: "run.waitingForUser"; at: string }
  | { type: "run.completed"; at: string }
  | { type: "run.failed"; at: string; error: TapRigError }
  | { type: "run.stopped"; at: string };
