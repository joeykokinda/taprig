import type { DeviceId } from "../core/contracts.ts";
import {
  type DeviceSnapshot,
  diagnoseReadiness,
  type ReadinessReport,
  type TaskRequirements,
} from "../devices/readiness.ts";

export type AssignmentResult =
  | { assigned: true; deviceId: DeviceId; report: ReadinessReport }
  | { assigned: false; reports: readonly ReadinessReport[] };

export function assignDevice(
  snapshots: readonly DeviceSnapshot[],
  requirements: TaskRequirements,
  now = new Date().toISOString(),
): AssignmentResult {
  const reports = [...snapshots]
    .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
    .map((snapshot) => diagnoseReadiness(snapshot, requirements, now));
  const ready = reports.find((report) => report.ready);

  return ready
    ? { assigned: true, deviceId: ready.deviceId, report: ready }
    : { assigned: false, reports };
}
