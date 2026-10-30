import type { Action, Selector } from "../core/contracts.ts";

export interface ScriptParameter {
  name: string;
  required: boolean;
  default?: string;
}

export interface ScriptCheckpoint {
  foregroundPackage?: string;
  selector?: Selector;
}

export interface ScriptStep {
  id: string;
  action: Action;
  checkpoint?: ScriptCheckpoint;
}

export interface TapRigScript {
  schemaVersion: 1;
  id: string;
  name: string;
  version: number;
  origin: "user" | "bundled" | "learned";
  parameters: readonly ScriptParameter[];
  steps: readonly ScriptStep[];
}

export type ScriptRunResult =
  | { status: "completed"; completedSteps: number }
  | { status: "recovery-needed"; completedSteps: number; stepId: string; reason: string };
