import type { Routine, RoutineFrequency, RoutineTarget } from "../../domain/automation/routine.js";

export interface AutomationGoalInspection {
  goalId: string;
  state: "ACTIVE" | "CANCELED" | "COMPLETED" | "FAILED";
  workbenchId: string;
}

export interface AutomationRunRecord {
  completedAt?: string;
  inputId?: string;
  occurrenceAt: string;
  queuedAt?: string;
  reasonCode?: string;
  result: "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELED" | "PENDING" | "RUNNING";
  runId: string;
  mergeCount: number;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELED";
  triggeredAt: string;
}

export interface AutomationRecord extends Routine {
  createIdempotencyKey?: string;
  nextRunAt?: string;
  runs: AutomationRunRecord[];
}

export interface AutomationTrigger {
  inputId?: string;
  routineId: string;
  runId: string;
}

export interface AutomationStore {
  claimDue(input: { now: string; timezone: string }): Promise<AutomationTrigger[]>;
  countActive(): Promise<number>;
  create(record: AutomationRecord): Promise<AutomationRecord>;
  get(routineId: string, includeDeleted?: boolean): Promise<AutomationRecord | null>;
  getByCreateIdempotencyKey?(key: string): Promise<AutomationRecord | null>;
  hasLiveRun(routineId: string): Promise<boolean>;
  inspectGoal(goalId: string): Promise<AutomationGoalInspection | null>;
  list(includeDeleted?: boolean): Promise<AutomationRecord[]>;
  revealPrompt(routineId: string): Promise<{ prompt: string } | null>;
  runNow(input: { idempotencyKey: string; inputId: string; routineId: string; now: string }): Promise<AutomationTrigger | null>;
  softDelete(routineId: string, now: string, idempotencyKey?: string): Promise<AutomationRecord | null>;
  update(routineId: string, patch: { enabled?: boolean; from?: string | null; frequency?: RoutineFrequency; name?: string; pendingTriggerAt?: string | null; preferredPartnerId?: string | null; prompt?: string; target?: RoutineTarget; to?: string | null; workbenchId?: string; nextRunAt?: string | null; lastRunAt?: string | null }, idempotencyKey?: string): Promise<AutomationRecord | null>;
}
