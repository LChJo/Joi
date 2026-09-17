/** Shared, non-sensitive Routine contracts used by HTTP, renderer and Joi tools. */
export type AutomationFrequency =
  | { kind: "cycle"; unit: "day" | "week" | "month"; localTime: string; daysOfWeek?: number[]; daysOfMonth?: number[] }
  | { kind: "interval"; hours: number; anchorAt?: string }
  | { kind: "once"; at: string }
  | { kind: "rrule"; rule: string; dtStart?: string };

export type AutomationLifecycle = "ACTIVE" | "PAUSED" | "EXPIRED" | "BLOCKED" | "DELETED";
export type AutomationRunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELED";
export type AutomationTarget =
  | { kind: "NEW_GOAL" }
  | { goalId: string; kind: "GOAL_CONTINUATION" };

export interface AutomationRunDto {
  completedAt?: string;
  inputId?: string;
  occurrenceAt: string;
  queuedAt?: string;
  reasonCode?: string;
  result: "COMPLETED" | "FAILED" | "BLOCKED" | "CANCELED" | "PENDING" | "RUNNING";
  runId: string;
  mergeCount: number;
  status: AutomationRunStatus;
  triggeredAt: string;
}

export interface AutomationDto {
  createdAt: string;
  enabled: boolean;
  from?: string;
  frequency: AutomationFrequency;
  lastRunAt?: string;
  lifecycle: AutomationLifecycle;
  name: string;
  nextRunAt?: string;
  pendingTriggerAt?: string;
  preferredPartnerId?: string;
  promptConfigured: boolean;
  routineId: string;
  runs: AutomationRunDto[];
  target: AutomationTarget;
  to?: string;
  workbenchId: string;
}

export interface CreateAutomationInput {
  from?: string;
  frequency: AutomationFrequency;
  name: string;
  preferredPartnerId?: string;
  prompt: string;
  target?: AutomationTarget;
  to?: string;
  workbenchId?: string;
}

export interface UpdateAutomationInput {
  enabled?: boolean;
  from?: string | null;
  frequency?: AutomationFrequency;
  name?: string;
  preferredPartnerId?: string | null;
  prompt?: string;
  target?: AutomationTarget;
  to?: string | null;
  workbenchId?: string;
}
