import type { CreateLifeEventRecord, ExpressionRecord, LifeEvent } from "./runtime-core-ports.js";
import type { SseEvent } from "./runtime-store.js";
import type { PublicAgentConnection } from "../../domain/agents/agent-connection.js";

export interface AffairRecord {
  affairId: string;
  createdAt: string;
  lifeId: string;
  status: "CANCELED" | "DONE" | "FAILED" | "OPEN" | "RUNNING" | "WAITING";
  summary?: string;
  title: string;
  updatedAt: string;
  waitingReason?: "AGENT_RESULT" | "AUTH" | "BUDGET" | "HUMAN_INPUT" | "TIME";
}

export interface TodoRecord {
  affairId?: string;
  assignee?: string;
  createdAt: string;
  dueAt?: string;
  lifeId: string;
  status: "CANCELED" | "DONE" | "IN_PROGRESS" | "OPEN";
  title: string;
  todoId: string;
  updatedAt: string;
}

export interface AlarmRecord {
  allowQuietHours: boolean;
  affairId?: string;
  alarmId: string;
  createdAt: string;
  creator: "AGENT" | "HUMAN";
  lifeId: string;
  nextAt: string;
  reason: string;
  recurrenceRule?: "DAILY" | "WEEKDAYS" | "WEEKENDS" | "WEEKLY";
  repeatEveryMinutes?: number;
  status: "CANCELED" | "FIRED" | "SCHEDULED";
  updatedAt: string;
}

export interface ScheduleRecord {
  enabled: boolean;
  kind: string;
  lifeId: string;
  localTime: string;
  lastFiredLocalDate?: string;
  scheduleId: string;
  timezone: string;
}

export interface MemoryRecord {
  affairId?: string;
  confidence: number;
  content: string;
  createdAt: string;
  entities?: { name: string; relation: string; type: string }[];
  kind: "CARD" | "EPISODIC" | "SEMANTIC";
  lifeId: string;
  memoryId: string;
  revision: number;
  sourceEventId?: string;
  status: "ACTIVE" | "FORGOTTEN" | "SUPERSEDED";
  updatedAt: string;
}

export interface DelegationRecord {
  affairId?: string;
  agentConnectionId: string;
  artifactIds?: string[];
  createdAt: string;
  delegationId: string;
  lifeId: string;
  invocationId?: string;
  sourceWakeId: string;
  status: "COMPLETED" | "FAILED" | "PENDING" | "RUNNING" | "UNKNOWN" | "WAITING_AUTH" | "WAITING_INPUT";
  task: string;
  title: string;
  updatedAt: string;
}

export interface DailyBudgetRecord {
  autonomousWakesLimit: number;
  autonomousWakesUsed: number;
  idleExplorationsLimit: number;
  idleExplorationsUsed: number;
  invocationsLimit: number;
  invocationsUsed: number;
  lifeId: string;
  localDate: string;
}

export interface ContinuityStore {
  deliverDueExpressions(now: string, limit: number): Promise<{ expressions: ExpressionRecord[]; sse: SseEvent[] }>;
  bindCollaborator(lifeId: string, agentConnectionId: string, now: string): Promise<void>;
  deferAlarmForQuietHours(input: { alarmId: string; expectedNextAt: string; nextAt: string; now: string }): Promise<boolean>;
  fireAlarmOccurrence(input: { event: CreateLifeEventRecord; now: string; occurrenceAt: string; occurrenceId: string; alarmId: string }): Promise<{ created: boolean; event: LifeEvent | null; sse: SseEvent[] }>;
  fireSchedule(input: { event: CreateLifeEventRecord; localDate: string; now: string; scheduleId: string }): Promise<{ created: boolean; event: LifeEvent | null; sse: SseEvent[] }>;
  fireTodoOccurrence(input: { event: CreateLifeEventRecord; now: string; occurrenceAt: string; todoId: string }): Promise<{ created: boolean; event: LifeEvent | null; sse: SseEvent[] }>;
  extendDailyBudget(input: { autonomousWakes: number; invocations: number; lifeId: string; localDate: string; now: string }): Promise<DailyBudgetRecord>;
  getDelegation(delegationId: string): Promise<DelegationRecord | null>;
  getDailyBudget(lifeId: string, localDate: string, now: string): Promise<DailyBudgetRecord>;
  listAffairs(lifeId: string): Promise<AffairRecord[]>;
  listAlarms(lifeId: string): Promise<AlarmRecord[]>;
  listDelegations(lifeId: string): Promise<DelegationRecord[]>;
  listLifeCollaborators(lifeId: string): Promise<PublicAgentConnection[]>;
  listDueAlarms(now: string, limit: number): Promise<AlarmRecord[]>;
  listDueTodos(now: string, limit: number): Promise<TodoRecord[]>;
  listMemories(lifeId: string): Promise<MemoryRecord[]>;
  listSchedules(lifeId: string): Promise<ScheduleRecord[]>;
  listEnabledSchedules(): Promise<ScheduleRecord[]>;
  listTodos(lifeId: string): Promise<TodoRecord[]>;
  recallMemories(input: { affairId?: string; lifeId: string; limit: number; now: string; query: string }): Promise<MemoryRecord[]>;
  updateDelegation(input: { delegationId: string; invocationId?: string; now: string; status: DelegationRecord["status"] }): Promise<DelegationRecord>;
  updateSchedule(input: { enabled: boolean; lifeId: string; localTime: string; now: string; scheduleId: string }): Promise<{ event: SseEvent; schedule: ScheduleRecord } | null>;
  unbindCollaborator(lifeId: string, agentConnectionId: string): Promise<boolean>;
}
