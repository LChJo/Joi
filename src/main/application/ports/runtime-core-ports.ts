import type { LifeActionEnvelopeV1 } from "../../domain/a2a/digital-life-envelope.js";
import type { EventPriority } from "../../domain/events/event-type-registry.js";
import type { Life, LifeState } from "../../domain/lives/life.js";
import type { RuntimeLease, SseEvent } from "./runtime-store.js";

export type LifeEventStatus = "CLAIMED" | "CONSUMED" | "DEAD_LETTER" | "DEFERRED" | "PENDING";
export type LifeEventSource = "agent" | "human" | "runtime" | "schedule" | "system";

export interface LifeEvent {
  affairId?: string;
  attemptCount: number;
  availableAt: string;
  claimedByWakeId?: string;
  dedupeKey?: string;
  eventId: string;
  lifeId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  priority: EventPriority;
  source: LifeEventSource;
  status: LifeEventStatus;
  type: string;
}

export interface LifeEventListPage {
  items: LifeEvent[];
  next?: { eventId: string; occurredAt: string };
}

export interface LifeRuntimeActivity {
  activityId: string;
  details: Record<string, string | number>;
  endedAt?: string | undefined;
  kind: "DELEGATION" | "FLOW" | "TURN" | "WAKE";
  startedAt: string;
  status: string;
  title: string;
}

export interface CreateLifeEventRecord extends LifeEvent {
  attachmentIds?: string[];
  createdAt: string;
}

export interface WakeRecord {
  createdAt: string;
  endedAt?: string;
  leaseGeneration: number;
  leaseOwner: string;
  lifeId: string;
  personaVersionId: string;
  repairCount: number;
  selectedEventCount: number;
  startedAt: string;
  status: "CANCELED" | "COMPLETED" | "CREATED" | "FAILED_PROTOCOL" | "RUNNING";
  updatedAt: string;
  wakeId: string;
}

export interface EventSignal {
  publish(wakeId: string, eventId: string): void;
  subscribe(wakeId: string, listener: (eventId: string) => void): () => void;
}

export interface ExpressionRecord {
  actionId: string;
  createdAt: string;
  deliveredAt?: string;
  deliverAfter?: string;
  expressionId: string;
  lifeId: string;
  text: string;
  wakeId: string;
}

export interface WakeActionRecord {
  actionId: string;
  actionKind: string;
  actionSetId: string;
  createdAt: string;
  lifeActionId: string;
  result: Record<string, unknown>;
  wakeId: string;
}

export interface WakeTurnRecord {
  endedAt?: string;
  invocationId?: string;
  lastActivityAt: string;
  messageId: string;
  startedAt: string;
  status: string;
  turnId: string;
  turnNumber: number;
  wakeId: string;
}

export interface RuntimeInjectionRecord {
  createdAt: string;
  injectionId: string;
  readAt?: string;
  sequence: number;
  sourceId: string;
  sourceType: "event" | "memory" | "result";
  turnId: string;
  wakeId: string;
}

export interface RuntimeCoreStore {
  claimWake(input: {
    allowedEventTypes: string[];
    autonomousExemptEventTypes: string[];
    budgetLocalDate: string;
    expiresAt: string;
    leaseOwner: string;
    maxBytes: number;
    maxEvents: number;
    now: string;
    wakeId: string;
  } & { lifeId: string }): Promise<{ events: LifeEvent[]; lease: RuntimeLease; sse: SseEvent[]; wake: WakeRecord } | null>;
  commitWakeActions(input: {
    envelope: LifeActionEnvelopeV1;
    expressionDeliverAfter?: string;
    forceSleep?: boolean;
    now: string;
    wakeId: string;
  }): Promise<{ expressions: ExpressionRecord[]; sse: SseEvent[]; state: LifeState }>;
  cancelActiveWake(lifeId: string, now: string): Promise<{ life: Life; sse: SseEvent[] }>;
  createLifeEvent(record: CreateLifeEventRecord): Promise<{ activeWakeId?: string; created: boolean; event: LifeEvent; sse?: SseEvent }>;
  getActiveWake(lifeId: string): Promise<WakeRecord | null>;
  emergencyStopLife(lifeId: string, now: string): Promise<{ life: Life; sse: SseEvent[] }>;
  getConsciousnessResidue(lifeId: string): Promise<{ text: string; updatedAt: string; wakeId: string } | null>;
  getLifeEvent(eventId: string): Promise<LifeEvent | null>;
  getWake(wakeId: string): Promise<WakeRecord | null>;
  incrementWakeRepair(wakeId: string, now: string): Promise<WakeRecord>;
  createWakeTurn(input: { messageId: string; now: string; turnId: string; wakeId: string }): Promise<WakeTurnRecord>;
  completeWakeTurn(turnId: string, now: string): Promise<WakeTurnRecord>;
  createRuntimeInjections(input: { now: string; sources: { injectionId: string; sourceId: string; sourceType: RuntimeInjectionRecord["sourceType"] }[]; turnId: string; wakeId: string }): Promise<RuntimeInjectionRecord[]>;
  heartbeatWakeTurn(turnId: string, now: string): Promise<void>;
  listLifeEvents(lifeId: string): Promise<LifeEvent[]>;
  listLifeEventsPage(input: { before?: { eventId: string; occurredAt: string }; lifeId: string; limit: number }): Promise<LifeEventListPage>;
  listLifeRuntimeActivity(lifeId: string, limit: number): Promise<LifeRuntimeActivity[]>;
  listWakeEvents(wakeId: string): Promise<LifeEvent[]>;
  listWakeTurns(wakeId: string): Promise<WakeTurnRecord[]>;
  listActiveWakes(): Promise<WakeRecord[]>;
  listRuntimeInjections(wakeId: string): Promise<RuntimeInjectionRecord[]>;
  claimWakeInjections(input: { allowedEventTypes: string[]; maxBytes: number; maxEvents: number; now: string; wakeId: string }): Promise<LifeEvent[]>;
  failWakeProtocol(input: {
    eventUpdates: { attemptCount: number; availableAt?: string; eventId: string; status: "DEAD_LETTER" | "PENDING" }[];
    now: string;
    recoveryEvent: CreateLifeEventRecord;
    wakeId: string;
  }): Promise<{ lifeState: LifeState; sse: SseEvent[] }>;
  recoverStaleWake(wakeId: string, now: string): Promise<{ recovered: boolean; sse: SseEvent[] }>;
  listExpressions(lifeId: string): Promise<ExpressionRecord[]>;
  listWakeActions(wakeId: string): Promise<WakeActionRecord[]>;
  setLifeState(lifeId: string, state: LifeState, now: string): Promise<Life | null>;
  startLifeWithBirth(input: { event: CreateLifeEventRecord; lifeId: string; now: string }): Promise<{ event: LifeEvent; life: Life; sse: SseEvent[] }>;
}
