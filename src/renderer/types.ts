export type LifeState = "BUDGET_PAUSED" | "DEGRADED" | "PAUSED" | "QUEUED" | "RUNNING" | "SLEEPING" | "STOPPED" | "WAITING_USER";

export interface LifeDto {
  archivedAt?: string;
  avatarUrl?: string;
  autonomousBudgetDailyLimit?: number;
  autonomousBudgetUsed?: number;
  autonomousWakesDefault?: number;
  createdAt: string;
  currentPersonaVersionId: string;
  initialGoal?: string;
  idleExplorationsDefault?: number;
  invocationsDefault?: number;
  lifeId: string;
  mainAgentConnectionId: string;
  name: string;
  nextWakeAt?: string;
  pendingEventCount?: number;
  personaSummary: string;
  principles: string[];
  quietEnd?: string;
  quietStart?: string;
  role?: string;
  state: LifeState;
  timezone: string;
  totalBudgetDailyLimit?: number;
  totalBudgetUsed?: number;
  updatedAt: string;
}

export interface LifeDeletionImpactDto {
  affairs: number;
  alarms: number;
  artifacts: number;
  attachments: number;
  delegations: number;
  events: number;
  managedBytes: number;
  memories: number;
  schedules: number;
  todos: number;
  wakes: number;
}

export interface PrimaryAgentHandoffDto {
  createdAt: string;
  fromAgentConnectionId: string;
  handoffId: string;
  lifeId: string;
  summary: string;
  toAgentConnectionId: string;
}

export interface AgentDto {
  agentConnectionId: string;
  credentialVersion?: number;
  description?: string;
  lifeBindings?: { lifeId: string; name: string; role: "COLLABORATOR" | "PRIMARY" }[];
  name: string;
  readiness?: boolean;
  recentInvocationStatus?: string;
  skills?: string[];
  status: "ACTIVE" | "COLLABORATOR_ONLY" | "DISABLED" | "DRAFT" | "ERROR" | "RECONFIRM_REQUIRED" | "TOKEN_REQUIRED";
  updatedAt: string;
}

export interface LifeEventDto {
  affairId?: string;
  attemptCount: number;
  availableAt: string;
  claimedByWakeId?: string;
  consumedAt?: string;
  createdAt: string;
  eventId: string;
  lifeId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  priority: number;
  source: "agent" | "human" | "schedule" | "system";
  status: "CLAIMED" | "CONSUMED" | "DEAD_LETTER" | "DEFERRED" | "PENDING";
  type: string;
}

export interface UserAttachmentDto {
  attachmentId: string;
  createdAt: string;
  filename: string;
  lifeId: string;
  mimeType: string;
  size: number;
}

export interface LifeRuntimeActivityDto {
  activityId: string;
  details: Record<string, string | number>;
  endedAt?: string | undefined;
  kind: "DELEGATION" | "FLOW" | "TURN" | "WAKE";
  startedAt: string;
  status: string;
  title: string;
}

export interface ExpressionDto {
  actionId: string;
  createdAt: string;
  deliveredAt?: string;
  expressionId: string;
  lifeId: string;
  text: string;
  wakeId: string;
}

export interface AffairDto {
  affairId: string;
  lifeId: string;
  status: "CANCELED" | "DONE" | "FAILED" | "OPEN" | "RUNNING" | "WAITING";
  summary?: string;
  title: string;
  updatedAt: string;
  waitingReason?: string;
}

export interface TodoDto {
  affairId?: string;
  assignee?: string;
  dueAt?: string;
  lifeId: string;
  status: "CANCELED" | "DONE" | "IN_PROGRESS" | "OPEN";
  title: string;
  todoId: string;
  updatedAt: string;
}

export interface AlarmDto {
  allowQuietHours?: boolean;
  affairId?: string;
  alarmId: string;
  creator?: "AGENT" | "HUMAN";
  lifeId: string;
  nextAt: string;
  reason: string;
  recurrenceRule?: "DAILY" | "WEEKDAYS" | "WEEKENDS" | "WEEKLY";
  repeatEveryMinutes?: number;
  status: "CANCELED" | "FIRED" | "SCHEDULED";
}

export interface MemoryDto {
  affairId?: string;
  confidence: number;
  content: string;
  entities?: { name: string; relation: string; type: string }[];
  kind: "CARD" | "EPISODIC" | "SEMANTIC";
  memoryId: string;
  revision: number;
  sourceEventId?: string;
  status: "ACTIVE" | "FORGOTTEN" | "SUPERSEDED";
  updatedAt: string;
}

export interface ScheduleDto {
  enabled: boolean;
  kind: string;
  localTime: string;
  scheduleId: string;
  timezone: string;
}

export interface DelegationDto {
  affairId?: string;
  agentConnectionId: string;
  delegationId: string;
  invocationId?: string;
  status: "COMPLETED" | "FAILED" | "PENDING" | "RUNNING" | "UNKNOWN" | "WAITING_AUTH" | "WAITING_INPUT";
  task: string;
  title: string;
  updatedAt: string;
}

export interface BudgetDto {
  autonomousWakesLimit: number;
  autonomousWakesUsed: number;
  idleExplorationsLimit: number;
  idleExplorationsUsed: number;
  invocationsLimit: number;
  invocationsUsed: number;
  lifeId: string;
  localDate: string;
}

export interface ContinuityDto {
  affairs: AffairDto[];
  alarms: AlarmDto[];
  budget: BudgetDto;
  collaborators?: AgentDto[];
  delegations: DelegationDto[];
  memories: MemoryDto[];
  schedules: ScheduleDto[];
  todos: TodoDto[];
}

export interface InteractionDto {
  createdAt: string;
  interactionId: string;
  invocationId: string;
  kind: "auth-required" | "input-required";
  prompt: string;
  status: "PENDING" | "RESOLVED";
}

export interface DiagnosticsDto {
  agents: { activeInvocations?: number; connections: number; openBreakers?: number };
  database: { integrity?: string; journalMode: string; state: string };
  recovery?: { uncleanShutdown: boolean };
  runtime: { activeWakes?: number; enabledSchedules?: number; leases?: number; pendingOutbox: number; scheduledAlarms?: number; staleWakeTurns?: number };
  schemaVersion: number;
  sse: { events: number };
  storage?: { artifactsBytes: number; backupsBytes: number; databaseBytes: number; diskAvailableBytes: number; state: "low" | "ok" };
  web: { lan?: Record<string, unknown>; loopback?: Record<string, unknown>; sessions: number };
}

export interface BackupDto {
  backupId: string;
  createdAt: string;
  databaseBytes: number;
  manifestHash: string;
  schemaVersion: number;
}

export interface SessionDto {
  createdAt: string;
  current: boolean;
  deviceId: string;
  ipSummary: string;
  kind: "desktop" | "lan";
  lastActivityAt: string;
}

export type { SystemSettingsDto } from "../shared/system-settings.js";
