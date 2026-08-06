/* SQLite is synchronous by design; the adapter keeps Promise-shaped ports for replaceability. */
/* eslint-disable @typescript-eslint/require-await */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import type {
  AdminCredentialRecord,
  LifeCreateRecord,
  LifeDeletionImpact,
  LifeHandoffContext,
  LifeListPage,
  LifeMutationResult,
  LifeOverviewFacts,
  OutboxInput,
  OutboxRecord,
  PrimaryAgentHandoff,
  RuntimeLease,
  RuntimeStats,
  RuntimeStore,
  SseEvent,
  SseSequenceWindow,
  WebSessionRecord,
} from "../../application/ports/runtime-store.js";
import type {
  AgentCardCandidate,
  ArtifactRecord,
  AgentIntegrationRecord,
  ConnectionBreakerRecord,
  InvocationRecord,
  InvocationStatus,
  InteractionRecord,
  PrimaryAgentContextRecord,
  SaveOnboardedAgentInput,
} from "../../application/ports/a2a-ports.js";
import type { UserAttachmentRecord } from "../../application/ports/attachment-ports.js";
import type { AgentConnection, AgentConnectionStatus, PublicAgentConnection } from "../../domain/agents/agent-connection.js";
import type {
  CreateLifeEventRecord,
  ExpressionRecord,
  LifeEvent,
  LifeEventListPage,
  LifeRuntimeActivity,
  LifeEventStatus,
  RuntimeInjectionRecord,
  WakeActionRecord,
  WakeRecord,
  WakeTurnRecord,
} from "../../application/ports/runtime-core-ports.js";
import type {
  AffairRecord,
  AlarmRecord,
  DailyBudgetRecord,
  DelegationRecord,
  MemoryRecord,
  ScheduleRecord,
  TodoRecord,
} from "../../application/ports/continuity-ports.js";
import { DomainError } from "../../domain/errors.js";
import { RhythmPolicy } from "../../domain/rhythm/rhythm-policy.js";
import type { LifeActionEnvelopeV1 } from "../../domain/a2a/digital-life-envelope.js";
import type { Life, UpdateLifeInput } from "../../domain/lives/life.js";

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | undefined {
  return value as Row | undefined;
}

function asRows(value: unknown): Row[] {
  return value as Row[];
}

function textValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Expected text column ${key}.`);
  return value;
}

function numberValue(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Expected number column ${key}.`);
  return value;
}

function optionalTextValue(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumberValue(row: Row, key: string): number | undefined {
  const value = row[key];
  return typeof value === "number" ? value : undefined;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("Persisted JSON object is invalid.");
  return parsed as Record<string, unknown>;
}

function actionText(action: Record<string, unknown>, key: string): string {
  const value = action[key];
  if (typeof value !== "string") throw new DomainError("action_schema_invalid", `${key} is invalid.`);
  return value;
}

function optionalActionText(action: Record<string, unknown>, key: string): string | undefined {
  const value = action[key];
  return typeof value === "string" ? value : undefined;
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("Persisted string array is invalid.");
  return parsed as string[];
}

function mapAgent(row: Row): AgentConnection {
  return {
    agentConnectionId: textValue(row, "agent_connection_id"),
    cardUrl: textValue(row, "card_url"),
    createdAt: textValue(row, "created_at"),
    name: textValue(row, "name"),
    status: agentStatus(row),
    updatedAt: textValue(row, "updated_at"),
  };
}

function mapPublicAgent(row: Row): PublicAgentConnection {
  const connection: PublicAgentConnection = {
    agentConnectionId: textValue(row, "agent_connection_id"),
    name: textValue(row, "name"),
    status: agentStatus(row),
    updatedAt: textValue(row, "updated_at"),
  };
  const description = optionalTextValue(row, "description");
  const credentialVersion = typeof row.credential_version === "number" ? row.credential_version : undefined;
  const readiness = typeof row.readiness === "number" ? row.readiness === 1 : undefined;
  const skills = typeof row.skills_json === "string" ? parseStringArray(row.skills_json) : undefined;
  return {
    ...connection,
    ...(credentialVersion === undefined ? {} : { credentialVersion }),
    ...(description === undefined ? {} : { description }),
    ...(readiness === undefined ? {} : { readiness }),
    ...(skills === undefined ? {} : { skills }),
  };
}

function agentStatus(row: Row): AgentConnectionStatus {
  return optionalNumberValue(row, "token_required") === 1
    ? "TOKEN_REQUIRED"
    : textValue(row, "status") as AgentConnectionStatus;
}

function mapCard(row: Row): AgentCardCandidate {
  return {
    authentication: "bearer",
    capabilities: { streaming: numberValue(row, "streaming") === 1 },
    cardHash: textValue(row, "card_hash"),
    cardUrl: textValue(row, "card_url"),
    cardUrlHash: textValue(row, "card_url_hash"),
    description: textValue(row, "description"),
    name: textValue(row, "name"),
    origin: textValue(row, "origin"),
    protocolVersion: textValue(row, "protocol_version"),
    rpcUrl: textValue(row, "rpc_url"),
    skills: parseStringArray(textValue(row, "skills_json")),
    transport: textValue(row, "transport") as AgentCardCandidate["transport"],
  };
}

function mapLife(row: Row): Life {
  const life: Life = {
    autonomousWakesDefault: numberValue(row, "autonomous_wakes_default"),
    createdAt: textValue(row, "created_at"),
    currentPersonaVersionId: textValue(row, "current_persona_version_id"),
    idleExplorationsDefault: numberValue(row, "idle_explorations_default"),
    invocationsDefault: numberValue(row, "invocations_default"),
    lifeId: textValue(row, "life_id"),
    mainAgentConnectionId: textValue(row, "main_agent_connection_id"),
    name: textValue(row, "name"),
    personaSummary: textValue(row, "persona_summary"),
    principles: parseStringArray(textValue(row, "principles_json")),
    quietEnd: textValue(row, "quiet_end"),
    quietStart: textValue(row, "quiet_start"),
    state: textValue(row, "state") as Life["state"],
    timezone: textValue(row, "timezone"),
    updatedAt: textValue(row, "updated_at"),
  };
  const avatarUrl = optionalTextValue(row, "avatar_url");
  const archivedAt = optionalTextValue(row, "archived_at");
  const initialGoal = optionalTextValue(row, "initial_goal");
  const role = optionalTextValue(row, "role");
  return {
    ...life,
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
    ...(initialGoal === undefined ? {} : { initialGoal }),
    ...(role === undefined ? {} : { role }),
  };
}

function mapPrimaryAgentHandoff(row: Row): PrimaryAgentHandoff {
  return {
    createdAt: textValue(row, "created_at"),
    fromAgentConnectionId: textValue(row, "from_agent_connection_id"),
    handoffId: textValue(row, "handoff_id"),
    lifeId: textValue(row, "life_id"),
    summary: textValue(row, "summary"),
    toAgentConnectionId: textValue(row, "to_agent_connection_id"),
  };
}

function mapSseEvent(row: Row): SseEvent {
  return {
    createdAt: textValue(row, "created_at"),
    entityId: textValue(row, "entity_id"),
    payload: parseObject(textValue(row, "payload_json")),
    sequence: numberValue(row, "sequence"),
    type: textValue(row, "event_type"),
  };
}

function mapOutbox(row: Row): OutboxRecord {
  const record: OutboxRecord = {
    attemptCount: numberValue(row, "attempt_count"),
    availableAt: textValue(row, "available_at"),
    createdAt: textValue(row, "created_at"),
    kind: textValue(row, "kind"),
    outboxId: textValue(row, "outbox_id"),
    payload: parseObject(textValue(row, "payload_json")),
    status: textValue(row, "status") as OutboxRecord["status"],
  };
  const claimOwner = optionalTextValue(row, "claim_owner");
  const claimUntil = optionalTextValue(row, "claim_until");
  return { ...record, ...(claimOwner === undefined ? {} : { claimOwner }), ...(claimUntil === undefined ? {} : { claimUntil }) };
}

function mapInvocation(row: Row): InvocationRecord {
  const parsed = parseObject(textValue(row, "request_json"));
  if (!Array.isArray(parsed.parts)) throw new Error("Persisted Invocation request is invalid.");
  const request = parsed as unknown as InvocationRecord["request"];
  const record: InvocationRecord = {
    agentConnectionId: textValue(row, "agent_connection_id"),
    createdAt: textValue(row, "created_at"),
    invocationId: textValue(row, "invocation_id"),
    lastActivityAt: textValue(row, "last_activity_at"),
    messageId: textValue(row, "message_id"),
    request,
    sendAttempts: numberValue(row, "send_attempts"),
    status: textValue(row, "status") as InvocationStatus,
    updatedAt: textValue(row, "updated_at"),
  };
  const acceptedAt = optionalTextValue(row, "accepted_at");
  const contextId = optionalTextValue(row, "context_id");
  const taskId = optionalTextValue(row, "task_id");
  return {
    ...record,
    ...(acceptedAt === undefined ? {} : { acceptedAt }),
    ...(contextId === undefined ? {} : { contextId }),
    ...(taskId === undefined ? {} : { taskId }),
  };
}

function mapInteraction(row: Row): InteractionRecord {
  return {
    createdAt: textValue(row, "created_at"),
    interactionId: textValue(row, "interaction_id"),
    invocationId: textValue(row, "invocation_id"),
    kind: textValue(row, "kind") as InteractionRecord["kind"],
    prompt: textValue(row, "prompt"),
    status: textValue(row, "status") as InteractionRecord["status"],
  };
}

function mapArtifact(row: Row): ArtifactRecord {
  const record: ArtifactRecord = {
    artifactId: textValue(row, "artifact_id"),
    createdAt: textValue(row, "created_at"),
    filename: textValue(row, "filename"),
    invocationId: textValue(row, "invocation_id"),
    mimeType: textValue(row, "mime_type"),
    remoteArtifactId: textValue(row, "remote_artifact_id"),
    size: numberValue(row, "size_bytes"),
  };
  const affairId = optionalTextValue(row, "affair_id");
  const lifeId = optionalTextValue(row, "life_id");
  const relativePath = optionalTextValue(row, "relative_path");
  const sha256 = optionalTextValue(row, "sha256");
  return {
    ...record,
    ...(affairId === undefined ? {} : { affairId }),
    ...(lifeId === undefined ? {} : { lifeId }),
    ...(relativePath === undefined ? {} : { relativePath }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

function mapLifeEvent(row: Row): LifeEvent {
  const event: LifeEvent = {
    attemptCount: numberValue(row, "attempt_count"),
    availableAt: textValue(row, "available_at"),
    eventId: textValue(row, "event_id"),
    lifeId: textValue(row, "life_id"),
    occurredAt: textValue(row, "occurred_at"),
    payload: parseObject(textValue(row, "payload_json")),
    priority: numberValue(row, "priority") as LifeEvent["priority"],
    source: textValue(row, "source") as LifeEvent["source"],
    status: textValue(row, "status") as LifeEventStatus,
    type: textValue(row, "event_type"),
  };
  const affairId = optionalTextValue(row, "affair_id");
  const claimedByWakeId = optionalTextValue(row, "claimed_by_wake_id");
  const dedupeKey = optionalTextValue(row, "dedupe_key");
  return {
    ...event,
    ...(affairId === undefined ? {} : { affairId }),
    ...(claimedByWakeId === undefined ? {} : { claimedByWakeId }),
    ...(dedupeKey === undefined ? {} : { dedupeKey }),
  };
}

function mapUserAttachment(row: Row): UserAttachmentRecord {
  const record: UserAttachmentRecord = {
    attachmentId: textValue(row, "attachment_id"),
    createdAt: textValue(row, "created_at"),
    filename: textValue(row, "filename"),
    lifeId: textValue(row, "life_id"),
    mimeType: textValue(row, "mime_type"),
    relativePath: textValue(row, "relative_path"),
    sha256: textValue(row, "sha256"),
    size: numberValue(row, "size_bytes"),
  };
  const eventId = optionalTextValue(row, "event_id");
  return { ...record, ...(eventId === undefined ? {} : { eventId }) };
}

function mapWake(row: Row): WakeRecord {
  const wake: WakeRecord = {
    createdAt: textValue(row, "created_at"),
    leaseGeneration: numberValue(row, "lease_generation"),
    leaseOwner: textValue(row, "lease_owner"),
    lifeId: textValue(row, "life_id"),
    personaVersionId: textValue(row, "persona_version_id"),
    repairCount: numberValue(row, "repair_count"),
    selectedEventCount: numberValue(row, "selected_event_count"),
    startedAt: textValue(row, "started_at"),
    status: textValue(row, "status") as WakeRecord["status"],
    updatedAt: textValue(row, "updated_at"),
    wakeId: textValue(row, "wake_id"),
  };
  const endedAt = optionalTextValue(row, "ended_at");
  return { ...wake, ...(endedAt === undefined ? {} : { endedAt }) };
}

function mapExpression(row: Row): ExpressionRecord {
  const expression: ExpressionRecord = {
    actionId: textValue(row, "action_id"),
    createdAt: textValue(row, "created_at"),
    expressionId: textValue(row, "expression_id"),
    lifeId: textValue(row, "life_id"),
    text: textValue(row, "text"),
    wakeId: textValue(row, "wake_id"),
  };
  const deliveredAt = optionalTextValue(row, "delivered_at");
  const deliverAfter = optionalTextValue(row, "deliver_after");
  return {
    ...expression,
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
    ...(deliverAfter === undefined ? {} : { deliverAfter }),
  };
}

function mapWakeAction(row: Row): WakeActionRecord {
  return {
    actionId: textValue(row, "action_id"),
    actionKind: textValue(row, "action_kind"),
    actionSetId: textValue(row, "action_set_id"),
    createdAt: textValue(row, "created_at"),
    lifeActionId: textValue(row, "life_action_id"),
    result: parseObject(textValue(row, "result_json")),
    wakeId: textValue(row, "wake_id"),
  };
}

function mapWakeTurn(row: Row): WakeTurnRecord {
  const turn: WakeTurnRecord = {
    lastActivityAt: textValue(row, "last_activity_at"),
    messageId: textValue(row, "message_id"),
    startedAt: textValue(row, "started_at"),
    status: textValue(row, "status"),
    turnId: textValue(row, "turn_id"),
    turnNumber: numberValue(row, "turn_number"),
    wakeId: textValue(row, "wake_id"),
  };
  const endedAt = optionalTextValue(row, "ended_at");
  const invocationId = optionalTextValue(row, "invocation_id");
  return { ...turn, ...(endedAt === undefined ? {} : { endedAt }), ...(invocationId === undefined ? {} : { invocationId }) };
}

function mapRuntimeInjection(row: Row): RuntimeInjectionRecord {
  const injection: RuntimeInjectionRecord = {
    createdAt: textValue(row, "created_at"),
    injectionId: textValue(row, "injection_id"),
    sequence: numberValue(row, "sequence"),
    sourceId: textValue(row, "source_id"),
    sourceType: textValue(row, "source_type") as RuntimeInjectionRecord["sourceType"],
    turnId: textValue(row, "turn_id"),
    wakeId: textValue(row, "wake_id"),
  };
  const readAt = optionalTextValue(row, "read_at");
  return { ...injection, ...(readAt === undefined ? {} : { readAt }) };
}

function mapAffair(row: Row): AffairRecord {
  const record: AffairRecord = {
    affairId: textValue(row, "affair_id"),
    createdAt: textValue(row, "created_at"),
    lifeId: textValue(row, "life_id"),
    status: textValue(row, "status") as AffairRecord["status"],
    title: textValue(row, "title"),
    updatedAt: textValue(row, "updated_at"),
  };
  const summary = optionalTextValue(row, "summary");
  const waitingReason = optionalTextValue(row, "waiting_reason") as AffairRecord["waitingReason"];
  return { ...record, ...(summary === undefined ? {} : { summary }), ...(waitingReason === undefined ? {} : { waitingReason }) };
}

function mapTodo(row: Row): TodoRecord {
  const record: TodoRecord = {
    createdAt: textValue(row, "created_at"),
    lifeId: textValue(row, "life_id"),
    status: textValue(row, "status") as TodoRecord["status"],
    title: textValue(row, "title"),
    todoId: textValue(row, "todo_id"),
    updatedAt: textValue(row, "updated_at"),
  };
  const affairId = optionalTextValue(row, "affair_id");
  const assignee = optionalTextValue(row, "assignee");
  const dueAt = optionalTextValue(row, "due_at");
  return { ...record, ...(affairId === undefined ? {} : { affairId }), ...(assignee === undefined ? {} : { assignee }), ...(dueAt === undefined ? {} : { dueAt }) };
}

function mapAlarm(row: Row): AlarmRecord {
  const record: AlarmRecord = {
    allowQuietHours: numberValue(row, "allow_quiet_hours") === 1,
    alarmId: textValue(row, "alarm_id"),
    createdAt: textValue(row, "created_at"),
    creator: textValue(row, "creator") as AlarmRecord["creator"],
    lifeId: textValue(row, "life_id"),
    nextAt: textValue(row, "next_at"),
    reason: textValue(row, "reason"),
    status: textValue(row, "status") as AlarmRecord["status"],
    updatedAt: textValue(row, "updated_at"),
  };
  const affairId = optionalTextValue(row, "affair_id");
  const recurrenceRule = optionalTextValue(row, "recurrence_rule") as AlarmRecord["recurrenceRule"];
  const repeatEveryMinutes = optionalNumberValue(row, "repeat_every_minutes");
  return { ...record, ...(affairId === undefined ? {} : { affairId }), ...(recurrenceRule === undefined ? {} : { recurrenceRule }), ...(repeatEveryMinutes === undefined ? {} : { repeatEveryMinutes }) };
}

function mapMemory(row: Row): MemoryRecord {
  const record: MemoryRecord = {
    confidence: numberValue(row, "confidence"),
    content: textValue(row, "content"),
    createdAt: textValue(row, "created_at"),
    kind: textValue(row, "kind") as MemoryRecord["kind"],
    lifeId: textValue(row, "life_id"),
    memoryId: textValue(row, "memory_id"),
    revision: numberValue(row, "revision"),
    status: textValue(row, "status") as MemoryRecord["status"],
    updatedAt: textValue(row, "updated_at"),
  };
  const affairId = optionalTextValue(row, "affair_id");
  const sourceEventId = optionalTextValue(row, "source_event_id");
  return { ...record, ...(affairId === undefined ? {} : { affairId }), ...(sourceEventId === undefined ? {} : { sourceEventId }) };
}

function mapSchedule(row: Row): ScheduleRecord {
  const record: ScheduleRecord = {
    enabled: numberValue(row, "enabled") === 1,
    kind: textValue(row, "kind"),
    lifeId: textValue(row, "life_id"),
    localTime: textValue(row, "local_time"),
    scheduleId: textValue(row, "schedule_id"),
    timezone: textValue(row, "timezone"),
  };
  const lastFiredLocalDate = optionalTextValue(row, "last_fired_local_date");
  return { ...record, ...(lastFiredLocalDate === undefined ? {} : { lastFiredLocalDate }) };
}

function mapDelegation(row: Row): DelegationRecord {
  const record: DelegationRecord = {
    agentConnectionId: textValue(row, "agent_connection_id"),
    createdAt: textValue(row, "created_at"),
    delegationId: textValue(row, "delegation_id"),
    lifeId: textValue(row, "life_id"),
    sourceWakeId: textValue(row, "source_wake_id"),
    status: textValue(row, "status") as DelegationRecord["status"],
    task: textValue(row, "task"),
    title: textValue(row, "title"),
    updatedAt: textValue(row, "updated_at"),
  };
  const affairId = optionalTextValue(row, "affair_id");
  const artifactIds = typeof row.artifact_ids_json === "string" ? parseStringArray(row.artifact_ids_json) : [];
  const invocationId = optionalTextValue(row, "invocation_id");
  return {
    ...record,
    ...(affairId === undefined ? {} : { affairId }),
    ...(artifactIds.length === 0 ? {} : { artifactIds }),
    ...(invocationId === undefined ? {} : { invocationId }),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function flowActivityTitle(eventType: string): string {
  const titles: Record<string, string> = {
    ActionsCommitted: "结构化动作已提交",
    ContextInjected: "上下文已注入 Turn",
    TurnCompleted: "主 Agent Turn 完成",
    TurnStarted: "主 Agent Turn 开始",
    WakeClaimed: "Wake 已领取事件",
    WakeEmergencyStopped: "Wake 被紧急停止",
    WakeEventsInjected: "新事件已注入 Wake",
    WakeProtocolFailed: "动作协议校验失败",
    WakeRecoveredStale: "陈旧 Wake 已恢复",
    WakeUserCanceled: "Wake 已由用户停止",
  };
  return titles[eventType] ?? eventType;
}

const LIFE_SELECT = `
  SELECT l.life_id, l.name, l.avatar_url, l.role, l.initial_goal, l.timezone, l.state, l.archived_at,
         l.quiet_start, l.quiet_end, l.autonomous_wakes_default, l.invocations_default, l.idle_explorations_default,
         l.main_agent_connection_id, l.current_persona_version_id,
         l.created_at, l.updated_at, p.summary AS persona_summary,
         p.principles_json
    FROM lives l
    JOIN persona_versions p ON p.persona_version_id = l.current_persona_version_id`;

class SqliteRuntimeStore implements RuntimeStore {
  constructor(private readonly database: DatabaseSync) {}

  async createLifeEvent(record: CreateLifeEventRecord): Promise<{ activeWakeId?: string; created: boolean; event: LifeEvent; sse?: SseEvent }> {
    return this.inTransaction(() => {
      if (record.dedupeKey !== undefined) {
        const existing = asRow(this.database.prepare(`
          SELECT * FROM life_events WHERE life_id = ? AND event_type = ? AND dedupe_key = ?`)
          .get(record.lifeId, record.type, record.dedupeKey));
        if (existing !== undefined) return { created: false, event: mapLifeEvent(existing) };
      }
      const attachments = this.attachmentsForMessageSync(record.lifeId, record.attachmentIds ?? []);
      const storedRecord: CreateLifeEventRecord = attachments.length === 0 ? record : {
        ...record,
        payload: {
          ...record.payload,
          attachments: attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
          })),
        },
      };
      this.insertLifeEventSync(storedRecord);
      if (attachments.length > 0) {
        const placeholders = attachments.map(() => "?").join(", ");
        const updated = this.database.prepare(`
          UPDATE user_attachments SET event_id = ?
           WHERE event_id IS NULL AND attachment_id IN (${placeholders})`)
          .run(record.eventId, ...attachments.map((attachment) => attachment.attachmentId));
        if (updated.changes !== attachments.length) throw new DomainError("attachment_already_used", "A message attachment was already assigned to another event.");
      }
      const event = this.getLifeEventSync(record.eventId);
      if (event === null) throw new Error("Life event could not be read after creation.");
      const sse = this.appendSseEventSync({
        entityId: record.lifeId,
        payload: { eventId: record.eventId, lifeId: record.lifeId, status: record.status, type: record.type },
        type: "event.created",
      }, record.createdAt);
      const active = asRow(this.database.prepare(`
        SELECT wake_id FROM wakes WHERE life_id = ? AND status IN ('CREATED', 'RUNNING')`).get(record.lifeId));
      const activeWakeId = active === undefined ? undefined : textValue(active, "wake_id");
      return { created: true, event, sse, ...(activeWakeId === undefined ? {} : { activeWakeId }) };
    });
  }

  async getLifeEvent(eventId: string): Promise<LifeEvent | null> {
    return this.getLifeEventSync(eventId);
  }

  async createUserAttachment(record: UserAttachmentRecord): Promise<UserAttachmentRecord> {
    this.database.prepare(`
      INSERT INTO user_attachments
        (attachment_id, life_id, event_id, filename, mime_type, size_bytes, relative_path, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.attachmentId, record.lifeId, record.eventId ?? null, record.filename, record.mimeType,
        record.size, record.relativePath, record.sha256, record.createdAt);
    const created = await this.getUserAttachment(record.attachmentId);
    if (created === null) throw new Error("User attachment could not be read after creation.");
    return created;
  }

  async getUserAttachment(attachmentId: string): Promise<UserAttachmentRecord | null> {
    const row = asRow(this.database.prepare("SELECT * FROM user_attachments WHERE attachment_id = ?").get(attachmentId));
    return row === undefined ? null : mapUserAttachment(row);
  }

  async listLifeUserAttachments(lifeId: string): Promise<UserAttachmentRecord[]> {
    return asRows(this.database.prepare(`
      SELECT * FROM user_attachments WHERE life_id = ? ORDER BY created_at, attachment_id`).all(lifeId)).map(mapUserAttachment);
  }

  async startLifeWithBirth(input: { event: CreateLifeEventRecord; lifeId: string; now: string }): Promise<{ event: LifeEvent; life: Life; sse: SseEvent[] }> {
    return this.inTransaction(() => {
      const life = this.getLifeSync(input.lifeId);
      if (life === null) throw new DomainError("life_not_found", "Life was not found.");
      const existingEvent = asRow(this.database.prepare(`
        SELECT * FROM life_events WHERE life_id = ? AND event_type = 'system.birth' AND dedupe_key = 'system.birth'`)
        .get(input.lifeId));
      if (life.state !== "STOPPED") {
        if (existingEvent === undefined) throw new DomainError("life_transition_invalid", "Started Life is missing its birth event.");
        return { event: mapLifeEvent(existingEvent), life, sse: [] };
      }
      this.database.prepare("UPDATE lives SET state = 'SLEEPING', updated_at = ? WHERE life_id = ?").run(input.now, input.lifeId);
      this.insertLifeEventSync(input.event);
      const event = this.getLifeEventSync(input.event.eventId);
      const updated = this.getLifeSync(input.lifeId);
      if (event === null || updated === null) throw new Error("Life start transaction could not be read back.");
      const eventSse = this.appendSseEventSync({
        entityId: input.lifeId,
        payload: { eventId: event.eventId, lifeId: input.lifeId, status: event.status, type: event.type },
        type: "event.created",
      }, input.now);
      const stateSse = this.appendSseEventSync({
        entityId: input.lifeId,
        payload: { lifeId: input.lifeId, state: "SLEEPING" },
        type: "life.state.changed",
      }, input.now);
      return { event, life: updated, sse: [eventSse, stateSse] };
    });
  }

  async setLifeState(lifeId: string, state: Life["state"], now: string): Promise<Life | null> {
    const result = this.database.prepare("UPDATE lives SET state = ?, updated_at = ? WHERE life_id = ?").run(state, now, lifeId);
    return result.changes === 0 ? null : this.getLifeSync(lifeId);
  }

  async emergencyStopLife(lifeId: string, now: string): Promise<{ life: Life; sse: SseEvent[] }> {
    return this.stopLifeWake(lifeId, now, "PAUSED", "emergency_stop");
  }

  async cancelActiveWake(lifeId: string, now: string): Promise<{ life: Life; sse: SseEvent[] }> {
    return this.stopLifeWake(lifeId, now, "SLEEPING", "user_stop_run");
  }

  private stopLifeWake(lifeId: string, now: string, targetState: "PAUSED" | "SLEEPING", reason: string): { life: Life; sse: SseEvent[] } {
    return this.inTransaction(() => {
      const life = this.getLifeSync(lifeId);
      if (life === null) throw new DomainError("life_not_found", "Life was not found.");
      if (life.state === "STOPPED") throw new DomainError("life_transition_invalid", "Stopped Life has no active run to cancel.");
      const wake = this.getActiveWakeSync(lifeId);
      if (wake !== null) {
        this.database.prepare(`
          UPDATE life_events
             SET status = 'PENDING', claimed_by_wake_id = NULL, last_error_code = ?
           WHERE claimed_by_wake_id = ? AND status = 'CLAIMED'`).run(reason, wake.wakeId);
        this.database.prepare(`
          UPDATE wake_turns SET status = 'CANCELED', ended_at = ?, last_activity_at = ?
           WHERE wake_id = ? AND status = 'RUNNING'`).run(now, now, wake.wakeId);
        this.database.prepare(`
          UPDATE wakes SET status = 'CANCELED', failure_code = ?, ended_at = ?, updated_at = ?
           WHERE wake_id = ?`).run(reason, now, now, wake.wakeId);
        this.database.prepare(`
          DELETE FROM runtime_leases
           WHERE resource_type = 'life' AND resource_id = ? AND owner = ? AND generation = ?`)
          .run(lifeId, wake.leaseOwner, wake.leaseGeneration);
        this.insertFlowEventSync(wake.wakeId, targetState === "PAUSED" ? "WakeEmergencyStopped" : "WakeUserCanceled", wake.wakeId, {}, now);
      }
      this.database.prepare("UPDATE lives SET state = ?, updated_at = ? WHERE life_id = ?").run(targetState, now, lifeId);
      const updated = this.getLifeSync(lifeId);
      if (updated === null) throw new Error("Life disappeared during emergency stop.");
      const sse: SseEvent[] = [];
      if (wake !== null) {
        sse.push(this.appendSseEventSync({
          entityId: wake.wakeId,
          payload: { lifeId, status: "CANCELED", wakeId: wake.wakeId },
          type: "wake.changed",
        }, now));
      }
      sse.push(this.appendSseEventSync({
        entityId: lifeId,
        payload: { lifeId, state: targetState },
        type: "life.state.changed",
      }, now));
      return { life: updated, sse };
    });
  }

  async getActiveWake(lifeId: string): Promise<WakeRecord | null> {
    const row = asRow(this.database.prepare(`
      SELECT * FROM wakes WHERE life_id = ? AND status IN ('CREATED', 'RUNNING')`).get(lifeId));
    return row === undefined ? null : mapWake(row);
  }

  async getWake(wakeId: string): Promise<WakeRecord | null> {
    const row = asRow(this.database.prepare("SELECT * FROM wakes WHERE wake_id = ?").get(wakeId));
    return row === undefined ? null : mapWake(row);
  }

  async listLifeEvents(lifeId: string): Promise<LifeEvent[]> {
    return asRows(this.database.prepare(`
      SELECT * FROM life_events WHERE life_id = ? ORDER BY occurred_at, event_id`).all(lifeId)).map(mapLifeEvent);
  }

  async listLifeEventsPage(input: { before?: { eventId: string; occurredAt: string }; lifeId: string; limit: number }): Promise<LifeEventListPage> {
    const rows = input.before === undefined
      ? asRows(this.database.prepare(`
          SELECT * FROM life_events WHERE life_id = ?
           ORDER BY occurred_at DESC, event_id DESC LIMIT ?`).all(input.lifeId, input.limit + 1))
      : asRows(this.database.prepare(`
          SELECT * FROM life_events
           WHERE life_id = ? AND (occurred_at < ? OR (occurred_at = ? AND event_id < ?))
           ORDER BY occurred_at DESC, event_id DESC LIMIT ?`)
        .all(input.lifeId, input.before.occurredAt, input.before.occurredAt, input.before.eventId, input.limit + 1));
    const hasNext = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map(mapLifeEvent);
    const last = items.at(-1);
    return {
      items,
      ...(hasNext && last !== undefined ? { next: { eventId: last.eventId, occurredAt: last.occurredAt } } : {}),
    };
  }

  async listLifeRuntimeActivity(lifeId: string, limit: number): Promise<LifeRuntimeActivity[]> {
    const wakes = asRows(this.database.prepare(`
      SELECT w.*, COUNT(wt.turn_id) AS turn_count
        FROM wakes w LEFT JOIN wake_turns wt ON wt.wake_id = w.wake_id
       WHERE w.life_id = ? GROUP BY w.wake_id
       ORDER BY w.started_at DESC, w.wake_id DESC LIMIT ?`).all(lifeId, limit)).map((row): LifeRuntimeActivity => ({
      activityId: textValue(row, "wake_id"),
      details: { eventCount: numberValue(row, "selected_event_count"), turnCount: numberValue(row, "turn_count") },
      ...(optionalTextValue(row, "ended_at") === undefined ? {} : { endedAt: optionalTextValue(row, "ended_at") }),
      kind: "WAKE",
      startedAt: textValue(row, "started_at"),
      status: textValue(row, "status"),
      title: "主 Agent Wake",
    }));
    const turns = asRows(this.database.prepare(`
      SELECT wt.*, i.status AS invocation_status, i.send_attempts, a.name AS agent_name
        FROM wake_turns wt
        JOIN wakes w ON w.wake_id = wt.wake_id
        LEFT JOIN invocations i ON i.invocation_id = wt.invocation_id
        LEFT JOIN agent_connections a ON a.agent_connection_id = i.agent_connection_id
       WHERE w.life_id = ? ORDER BY wt.started_at DESC, wt.turn_id DESC LIMIT ?`).all(lifeId, limit)).map((row): LifeRuntimeActivity => {
      const invocationStatus = optionalTextValue(row, "invocation_status");
      const agentName = optionalTextValue(row, "agent_name");
      return {
        activityId: textValue(row, "turn_id"),
        details: {
          turnNumber: numberValue(row, "turn_number"),
          ...(invocationStatus === undefined ? {} : { invocationStatus }),
          ...(agentName === undefined ? {} : { agentName }),
          ...(row.send_attempts === null || row.send_attempts === undefined ? {} : { sendAttempts: numberValue(row, "send_attempts") }),
        },
        ...(optionalTextValue(row, "ended_at") === undefined ? {} : { endedAt: optionalTextValue(row, "ended_at") }),
        kind: "TURN",
        startedAt: textValue(row, "started_at"),
        status: textValue(row, "status"),
        title: `主 Agent Turn ${String(numberValue(row, "turn_number"))}`,
      };
    });
    const flows = asRows(this.database.prepare(`
      SELECT f.* FROM flow_events f JOIN wakes w ON w.wake_id = f.wake_id
       WHERE w.life_id = ? ORDER BY f.created_at DESC, f.flow_event_id DESC LIMIT ?`).all(lifeId, limit)).map((row): LifeRuntimeActivity => {
      const metadata = parseObject(textValue(row, "metadata_json"));
      const details = Object.fromEntries(Object.entries(metadata).filter((entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number"));
      return {
        activityId: textValue(row, "flow_event_id"), details, kind: "FLOW", startedAt: textValue(row, "created_at"),
        status: textValue(row, "event_type"), title: flowActivityTitle(textValue(row, "event_type")),
      };
    });
    const delegations = asRows(this.database.prepare(`
      SELECT d.*, a.name AS agent_name FROM delegations d
        JOIN agent_connections a ON a.agent_connection_id = d.agent_connection_id
       WHERE d.life_id = ? ORDER BY d.updated_at DESC, d.delegation_id DESC LIMIT ?`).all(lifeId, limit)).map((row): LifeRuntimeActivity => ({
      activityId: textValue(row, "delegation_id"),
      details: { agentName: textValue(row, "agent_name") },
      kind: "DELEGATION",
      startedAt: textValue(row, "created_at"),
      status: textValue(row, "status"),
      title: textValue(row, "title"),
    }));
    return [...wakes, ...turns, ...flows, ...delegations]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.activityId.localeCompare(left.activityId))
      .slice(0, limit);
  }

  async listWakeEvents(wakeId: string): Promise<LifeEvent[]> {
    return asRows(this.database.prepare(`
      SELECT * FROM life_events WHERE claimed_by_wake_id = ? ORDER BY priority, available_at, occurred_at, event_id`)
      .all(wakeId)).map(mapLifeEvent);
  }

  async incrementWakeRepair(wakeId: string, now: string): Promise<WakeRecord> {
    const result = this.database.prepare(`
      UPDATE wakes SET repair_count = repair_count + 1, updated_at = ?
       WHERE wake_id = ? AND status = 'RUNNING' AND repair_count = 0`).run(now, wakeId);
    if (result.changes === 0) throw new DomainError("wake_repair_unavailable", "Wake repair is no longer available.");
    const wake = await this.getWake(wakeId);
    if (wake === null) throw new Error("Wake disappeared during repair update.");
    return wake;
  }

  async createWakeTurn(input: { messageId: string; now: string; turnId: string; wakeId: string }): Promise<WakeTurnRecord> {
    return this.inTransaction(() => {
      const wakeRow = asRow(this.database.prepare("SELECT status FROM wakes WHERE wake_id = ?").get(input.wakeId));
      if (wakeRow === undefined || textValue(wakeRow, "status") !== "RUNNING") throw new DomainError("wake_not_active", "Wake is not active.");
      const countRow = asRow(this.database.prepare("SELECT COUNT(*) AS count FROM wake_turns WHERE wake_id = ?").get(input.wakeId));
      const turnNumber = (countRow === undefined ? 0 : numberValue(countRow, "count")) + 1;
      if (turnNumber > 4) throw new DomainError("wake_turn_limit", "Wake cannot exceed four main Agent Turns.");
      this.database.prepare(`
        INSERT INTO wake_turns
          (turn_id, wake_id, turn_number, message_id, status, started_at, last_activity_at)
        VALUES (?, ?, ?, ?, 'RUNNING', ?, ?)`)
        .run(input.turnId, input.wakeId, turnNumber, input.messageId, input.now, input.now);
      this.insertFlowEventSync(input.wakeId, "TurnStarted", input.turnId, { turnNumber }, input.now);
      const row = asRow(this.database.prepare("SELECT * FROM wake_turns WHERE turn_id = ?").get(input.turnId));
      if (row === undefined) throw new Error("Wake Turn could not be read after creation.");
      return mapWakeTurn(row);
    });
  }

  async completeWakeTurn(turnId: string, now: string): Promise<WakeTurnRecord> {
    return this.inTransaction(() => {
      const row = asRow(this.database.prepare("SELECT * FROM wake_turns WHERE turn_id = ? AND status = 'RUNNING'").get(turnId));
      if (row === undefined) throw new DomainError("turn_not_active", "Wake Turn is not active.");
      const wakeId = textValue(row, "wake_id");
      this.database.prepare(`
        UPDATE wake_turns SET status = 'COMPLETED', ended_at = ?, last_activity_at = ? WHERE turn_id = ?`)
        .run(now, now, turnId);
      this.insertFlowEventSync(wakeId, "TurnCompleted", turnId, {}, now);
      const completed = asRow(this.database.prepare("SELECT * FROM wake_turns WHERE turn_id = ?").get(turnId));
      if (completed === undefined) throw new Error("Wake Turn disappeared during completion.");
      return mapWakeTurn(completed);
    });
  }

  async createRuntimeInjections(input: {
    now: string;
    sources: { injectionId: string; sourceId: string; sourceType: RuntimeInjectionRecord["sourceType"] }[];
    turnId: string;
    wakeId: string;
  }): Promise<RuntimeInjectionRecord[]> {
    return this.inTransaction(() => {
      const turn = asRow(this.database.prepare("SELECT wake_id FROM wake_turns WHERE turn_id = ?").get(input.turnId));
      if (turn === undefined || textValue(turn, "wake_id") !== input.wakeId) throw new DomainError("turn_reference_invalid", "Injection Turn does not belong to the Wake.");
      const output: RuntimeInjectionRecord[] = [];
      for (const [index, source] of input.sources.entries()) {
        this.database.prepare(`
          INSERT INTO runtime_injections
            (injection_id, wake_id, turn_id, source_type, source_id, sequence, read_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(source.injectionId, input.wakeId, input.turnId, source.sourceType, source.sourceId, index + 1, input.now, input.now);
        const row = asRow(this.database.prepare("SELECT * FROM runtime_injections WHERE injection_id = ?").get(source.injectionId));
        if (row !== undefined) output.push(mapRuntimeInjection(row));
      }
      this.insertFlowEventSync(input.wakeId, "ContextInjected", input.turnId, { sourceCount: output.length }, input.now);
      return output;
    });
  }

  async heartbeatWakeTurn(turnId: string, now: string): Promise<void> {
    const result = this.database.prepare("UPDATE wake_turns SET last_activity_at = ? WHERE turn_id = ? AND status = 'RUNNING'").run(now, turnId);
    if (result.changes === 0) throw new DomainError("turn_not_active", "Wake Turn is not active.");
  }

  async listWakeTurns(wakeId: string): Promise<WakeTurnRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM wake_turns WHERE wake_id = ? ORDER BY turn_number").all(wakeId)).map(mapWakeTurn);
  }

  async listActiveWakes(): Promise<WakeRecord[]> {
    return asRows(this.database.prepare(`
      SELECT * FROM wakes WHERE status IN ('CREATED', 'RUNNING') ORDER BY created_at, wake_id`).all()).map(mapWake);
  }

  async listRuntimeInjections(wakeId: string): Promise<RuntimeInjectionRecord[]> {
    return asRows(this.database.prepare(`
      SELECT * FROM runtime_injections WHERE wake_id = ? ORDER BY created_at, sequence, injection_id`).all(wakeId))
      .map(mapRuntimeInjection);
  }

  async failWakeProtocol(input: {
    eventUpdates: { attemptCount: number; availableAt?: string; eventId: string; status: "DEAD_LETTER" | "PENDING" }[];
    now: string;
    recoveryEvent: CreateLifeEventRecord;
    wakeId: string;
  }): Promise<{ lifeState: Life["state"]; sse: SseEvent[] }> {
    return this.inTransaction(() => {
      const wakeRow = asRow(this.database.prepare("SELECT * FROM wakes WHERE wake_id = ? AND status = 'RUNNING'").get(input.wakeId));
      if (wakeRow === undefined) throw new DomainError("wake_not_active", "Wake is not active.");
      const wake = mapWake(wakeRow);
      for (const update of input.eventUpdates) {
        this.database.prepare(`
          UPDATE life_events
             SET attempt_count = ?, status = ?, available_at = COALESCE(?, available_at),
                 claimed_by_wake_id = NULL, last_error_code = 'action_schema_invalid'
           WHERE event_id = ? AND claimed_by_wake_id = ?`)
          .run(update.attemptCount, update.status, update.availableAt ?? null, update.eventId, input.wakeId);
      }
      this.insertLifeEventSync(input.recoveryEvent);
      this.database.prepare(`
        UPDATE wakes SET status = 'FAILED_PROTOCOL', failure_code = 'action_schema_invalid', ended_at = ?, updated_at = ?
         WHERE wake_id = ?`).run(input.now, input.now, input.wakeId);
      this.database.prepare("DELETE FROM runtime_leases WHERE resource_type = 'life' AND resource_id = ? AND owner = ? AND generation = ?")
        .run(wake.lifeId, wake.leaseOwner, wake.leaseGeneration);
      const lifeRow = asRow(this.database.prepare("SELECT protocol_failure_count FROM lives WHERE life_id = ?").get(wake.lifeId));
      const failures = (lifeRow === undefined ? 0 : numberValue(lifeRow, "protocol_failure_count")) + 1;
      const lifeState: Life["state"] = failures >= 3 ? "DEGRADED" : "SLEEPING";
      this.database.prepare("UPDATE lives SET state = ?, protocol_failure_count = ?, updated_at = ? WHERE life_id = ?")
        .run(lifeState, failures, input.now, wake.lifeId);
      this.insertFlowEventSync(input.wakeId, "WakeProtocolFailed", input.wakeId, { failures }, input.now);
      const recoverySse = this.appendSseEventSync({
        entityId: wake.lifeId,
        payload: { eventId: input.recoveryEvent.eventId, lifeId: wake.lifeId, status: "PENDING", type: "system.recovery" },
        type: "event.created",
      }, input.now);
      const wakeSse = this.appendSseEventSync({
        entityId: input.wakeId,
        payload: { lifeId: wake.lifeId, status: "FAILED_PROTOCOL", wakeId: input.wakeId },
        type: "wake.changed",
      }, input.now);
      const stateSse = this.appendSseEventSync({
        entityId: wake.lifeId,
        payload: { lifeId: wake.lifeId, state: lifeState },
        type: "life.state.changed",
      }, input.now);
      return { lifeState, sse: [recoverySse, wakeSse, stateSse] };
    });
  }

  async recoverStaleWake(wakeId: string, now: string): Promise<{ recovered: boolean; sse: SseEvent[] }> {
    return this.inTransaction(() => {
      const wakeRow = asRow(this.database.prepare(`
        SELECT * FROM wakes WHERE wake_id = ? AND status IN ('CREATED', 'RUNNING')`).get(wakeId));
      if (wakeRow === undefined) return { recovered: false, sse: [] };
      const wake = mapWake(wakeRow);
      this.database.prepare(`
        UPDATE life_events
           SET status = 'PENDING', claimed_by_wake_id = NULL, last_error_code = 'wake_stale'
         WHERE claimed_by_wake_id = ? AND status = 'CLAIMED'`).run(wakeId);
      this.database.prepare(`
        UPDATE wakes SET status = 'CANCELED', failure_code = 'wake_stale', ended_at = ?, updated_at = ?
         WHERE wake_id = ?`).run(now, now, wakeId);
      this.database.prepare(`
        DELETE FROM runtime_leases
         WHERE resource_type = 'life' AND resource_id = ? AND owner = ? AND generation = ?`)
        .run(wake.lifeId, wake.leaseOwner, wake.leaseGeneration);
      const pendingRow = asRow(this.database.prepare(`
        SELECT COUNT(*) AS count FROM life_events WHERE life_id = ? AND status = 'PENDING'`).get(wake.lifeId));
      const state: Life["state"] = pendingRow !== undefined && numberValue(pendingRow, "count") > 0 ? "QUEUED" : "SLEEPING";
      this.database.prepare("UPDATE lives SET state = ?, updated_at = ? WHERE life_id = ?").run(state, now, wake.lifeId);
      this.insertFlowEventSync(wakeId, "WakeRecoveredStale", wakeId, {}, now);
      const wakeSse = this.appendSseEventSync({
        entityId: wakeId,
        payload: { lifeId: wake.lifeId, status: "CANCELED", wakeId },
        type: "wake.changed",
      }, now);
      const stateSse = this.appendSseEventSync({
        entityId: wake.lifeId,
        payload: { lifeId: wake.lifeId, state },
        type: "life.state.changed",
      }, now);
      return { recovered: true, sse: [wakeSse, stateSse] };
    });
  }

  async claimWake(input: {
    allowedEventTypes: string[];
    autonomousExemptEventTypes: string[];
    budgetLocalDate: string;
    expiresAt: string;
    leaseOwner: string;
    lifeId: string;
    maxBytes: number;
    maxEvents: number;
    now: string;
    wakeId: string;
  }): Promise<{ events: LifeEvent[]; lease: RuntimeLease; sse: SseEvent[]; wake: WakeRecord } | null> {
    return this.inTransaction(() => {
      const life = this.getLifeSync(input.lifeId);
      if (life === null || !new Set(["SLEEPING", "QUEUED", "WAITING_USER"]).has(life.state)) return null;
      const active = this.getActiveWakeSync(input.lifeId);
      if (active !== null || input.allowedEventTypes.length === 0) return null;
      const placeholders = input.allowedEventTypes.map(() => "?").join(",");
      const rows = asRows(this.database.prepare(`
        SELECT * FROM life_events
         WHERE life_id = ? AND status = 'PENDING' AND available_at <= ?
           AND event_type IN (${placeholders})
         ORDER BY priority ASC, available_at ASC, occurred_at ASC, event_id ASC
         LIMIT ?`).all(input.lifeId, input.now, ...input.allowedEventTypes, input.maxEvents));
      const selectedRows: Row[] = [];
      let bytes = 0;
      for (const row of rows) {
        const rowBytes = Buffer.byteLength(textValue(row, "payload_json"), "utf8");
        if (selectedRows.length > 0 && bytes + rowBytes > input.maxBytes) break;
        if (rowBytes > input.maxBytes) continue;
        selectedRows.push(row);
        bytes += rowBytes;
      }
      if (selectedRows.length === 0) return null;

      this.database.prepare(`
        INSERT INTO daily_budgets (life_id, local_date, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(life_id, local_date) DO NOTHING`).run(input.lifeId, input.budgetLocalDate, input.now);
      const budget = asRow(this.database.prepare(`
        SELECT * FROM daily_budgets WHERE life_id = ? AND local_date = ?`).get(input.lifeId, input.budgetLocalDate));
      if (budget === undefined) throw new Error("Wake budget could not be initialized.");
      const consumesAutonomous = !selectedRows.some((row) => input.autonomousExemptEventTypes.includes(textValue(row, "event_type")));
      const consumesIdleExploration = selectedRows.some((row) => textValue(row, "event_type") === "idle.explore");
      const invocationExhausted = numberValue(budget, "invocations_used") >= numberValue(budget, "invocations_limit");
      const autonomousExhausted = consumesAutonomous
        && numberValue(budget, "autonomous_wakes_used") >= numberValue(budget, "autonomous_wakes_limit");
      const idleExhausted = consumesIdleExploration
        && numberValue(budget, "idle_explorations_used") >= numberValue(budget, "idle_explorations_limit");
      if (invocationExhausted || autonomousExhausted || idleExhausted) {
        this.database.prepare("UPDATE lives SET state = 'BUDGET_PAUSED', updated_at = ? WHERE life_id = ?").run(input.now, input.lifeId);
        return null;
      }
      this.database.prepare(`
        UPDATE daily_budgets
           SET invocations_used = invocations_used + 1,
               autonomous_wakes_used = autonomous_wakes_used + ?,
               idle_explorations_used = idle_explorations_used + ?, updated_at = ?
         WHERE life_id = ? AND local_date = ?`)
        .run(consumesAutonomous ? 1 : 0, consumesIdleExploration ? 1 : 0, input.now, input.lifeId, input.budgetLocalDate);

      const existingLease = asRow(this.database.prepare(`
        SELECT owner, generation, expires_at FROM runtime_leases WHERE resource_type = 'life' AND resource_id = ?`)
        .get(input.lifeId));
      let generation = 1;
      if (existingLease !== undefined) {
        if (textValue(existingLease, "expires_at") > input.now && textValue(existingLease, "owner") !== input.leaseOwner) return null;
        generation = numberValue(existingLease, "generation") + 1;
        this.database.prepare(`
          UPDATE runtime_leases SET owner = ?, generation = ?, expires_at = ?
           WHERE resource_type = 'life' AND resource_id = ?`)
          .run(input.leaseOwner, generation, input.expiresAt, input.lifeId);
      } else {
        this.database.prepare(`
          INSERT INTO runtime_leases (resource_type, resource_id, owner, generation, expires_at)
          VALUES ('life', ?, ?, 1, ?)`)
          .run(input.lifeId, input.leaseOwner, input.expiresAt);
      }
      this.database.prepare(`
        INSERT INTO wakes
          (wake_id, life_id, persona_version_id, status, lease_owner, lease_generation,
           selected_event_count, repair_count, started_at, created_at, updated_at)
        VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, 0, ?, ?, ?)`)
        .run(input.wakeId, input.lifeId, life.currentPersonaVersionId, input.leaseOwner, generation,
          selectedRows.length, input.now, input.now, input.now);
      const claim = this.database.prepare("UPDATE life_events SET status = 'CLAIMED', claimed_by_wake_id = ? WHERE event_id = ? AND status = 'PENDING'");
      for (const row of selectedRows) claim.run(input.wakeId, textValue(row, "event_id"));
      this.database.prepare("UPDATE lives SET state = 'RUNNING', updated_at = ? WHERE life_id = ?").run(input.now, input.lifeId);
      this.database.prepare(`
        INSERT INTO flow_events (flow_event_id, wake_id, sequence, event_type, entity_id, correlation_id, metadata_json, created_at)
        VALUES (?, ?, 1, 'WakeClaimed', ?, ?, ?, ?)`)
        .run(`flow_${input.wakeId}_1`, input.wakeId, input.lifeId, input.wakeId, JSON.stringify({ eventCount: selectedRows.length }), input.now);
      const wakeSse = this.appendSseEventSync({
        entityId: input.wakeId,
        payload: { lifeId: input.lifeId, status: "RUNNING", wakeId: input.wakeId },
        type: "wake.changed",
      }, input.now);
      const stateSse = this.appendSseEventSync({
        entityId: input.lifeId,
        payload: { lifeId: input.lifeId, state: "RUNNING" },
        type: "life.state.changed",
      }, input.now);
      const wake = this.getActiveWakeSync(input.lifeId);
      if (wake === null) throw new Error("Claimed Wake could not be read back.");
      const events = selectedRows.map((row) => ({ ...mapLifeEvent(row), claimedByWakeId: input.wakeId, status: "CLAIMED" as const }));
      return {
        events,
        lease: { expiresAt: input.expiresAt, generation, owner: input.leaseOwner, resourceId: input.lifeId, resourceType: "life" },
        sse: [wakeSse, stateSse],
        wake,
      };
    });
  }

  async claimWakeInjections(input: {
    allowedEventTypes: string[];
    maxBytes: number;
    maxEvents: number;
    now: string;
    wakeId: string;
  }): Promise<LifeEvent[]> {
    return this.inTransaction(() => {
      const wakeRow = asRow(this.database.prepare("SELECT life_id FROM wakes WHERE wake_id = ? AND status = 'RUNNING'").get(input.wakeId));
      if (wakeRow === undefined || input.allowedEventTypes.length === 0) return [];
      const lifeId = textValue(wakeRow, "life_id");
      const placeholders = input.allowedEventTypes.map(() => "?").join(",");
      const rows = asRows(this.database.prepare(`
        SELECT * FROM life_events
         WHERE life_id = ? AND status = 'PENDING' AND available_at <= ?
           AND event_type IN (${placeholders})
         ORDER BY priority ASC, available_at ASC, occurred_at ASC, event_id ASC
         LIMIT ?`).all(lifeId, input.now, ...input.allowedEventTypes, input.maxEvents));
      const selectedRows: Row[] = [];
      let bytes = 0;
      for (const row of rows) {
        const rowBytes = Buffer.byteLength(textValue(row, "payload_json"), "utf8");
        if (selectedRows.length > 0 && bytes + rowBytes > input.maxBytes) break;
        if (rowBytes > input.maxBytes) continue;
        selectedRows.push(row);
        bytes += rowBytes;
      }
      const claim = this.database.prepare(`
        UPDATE life_events SET status = 'CLAIMED', claimed_by_wake_id = ?
         WHERE event_id = ? AND status = 'PENDING'`);
      for (const row of selectedRows) claim.run(input.wakeId, textValue(row, "event_id"));
      if (selectedRows.length > 0) {
        this.database.prepare(`
          UPDATE wakes SET selected_event_count = selected_event_count + ?, updated_at = ? WHERE wake_id = ?`)
          .run(selectedRows.length, input.now, input.wakeId);
        this.insertFlowEventSync(input.wakeId, "WakeEventsInjected", input.wakeId,
          { eventCount: selectedRows.length }, input.now);
      }
      return selectedRows.map((row) => ({
        ...mapLifeEvent(row),
        claimedByWakeId: input.wakeId,
        status: "CLAIMED" as const,
      }));
    });
  }

  async commitWakeActions(input: { envelope: LifeActionEnvelopeV1; expressionDeliverAfter?: string; forceSleep?: boolean; now: string; wakeId: string }): Promise<{ expressions: ExpressionRecord[]; sse: SseEvent[]; state: Life["state"] }> {
    return this.inTransaction(() => {
      const wakeRow = asRow(this.database.prepare("SELECT * FROM wakes WHERE wake_id = ?").get(input.wakeId));
      if (wakeRow === undefined) throw new DomainError("wake_not_found", "Wake was not found.");
      const wake = mapWake(wakeRow);
      if (wake.status === "COMPLETED") {
        return { expressions: this.listExpressionsForWakeSync(input.wakeId), sse: [], state: "SLEEPING" };
      }
      if (wake.status !== "RUNNING") throw new DomainError("wake_not_active", "Wake is not active.");
      const newAffairIds = new Set(input.envelope.actions
        .filter((action) => action.kind === "affair.upsert")
        .map((action) => optionalActionText(action, "affairId") ?? `affair_${action.actionId}`));
      const assertAffair = (affairId: string | undefined) => {
        if (affairId === undefined) return;
        const row = asRow(this.database.prepare("SELECT life_id FROM affairs WHERE affair_id = ?").get(affairId));
        if (row === undefined && newAffairIds.has(affairId)) return;
        if (row === undefined || textValue(row, "life_id") !== wake.lifeId) {
          throw new DomainError("action_reference_invalid", "Affair does not belong to the active Life.");
        }
      };
      for (const action of input.envelope.actions) {
        const affairId = optionalActionText(action, "affairId");
        assertAffair(affairId);
        if (action.kind === "todo.upsert") {
          const todoId = optionalActionText(action, "todoId");
          if (todoId !== undefined) {
            const row = asRow(this.database.prepare("SELECT life_id FROM todos WHERE todo_id = ?").get(todoId));
            if (row !== undefined && textValue(row, "life_id") !== wake.lifeId) throw new DomainError("action_reference_invalid", "Todo does not belong to the active Life.");
          }
        }
        if (action.kind === "memory.append") {
          const sourceEventId = optionalActionText(action, "sourceEventId");
          if (sourceEventId !== undefined) {
            const row = asRow(this.database.prepare("SELECT life_id FROM life_events WHERE event_id = ?").get(sourceEventId));
            if (row === undefined || textValue(row, "life_id") !== wake.lifeId) throw new DomainError("action_reference_invalid", "Memory source event does not belong to the active Life.");
          }
        }
        if (action.kind === "memory.revise") {
          const row = asRow(this.database.prepare("SELECT life_id FROM memory_fragments WHERE memory_id = ?").get(actionText(action, "memoryId")));
          if (row === undefined || textValue(row, "life_id") !== wake.lifeId) throw new DomainError("action_reference_invalid", "Memory does not belong to the active Life.");
        }
        if (action.kind === "alarm.schedule" || action.kind === "alarm.cancel") {
          const alarmId = optionalActionText(action, "alarmId");
          if (alarmId !== undefined) {
            const row = asRow(this.database.prepare("SELECT life_id FROM alarms WHERE alarm_id = ?").get(alarmId));
            if (row !== undefined && textValue(row, "life_id") !== wake.lifeId) throw new DomainError("action_reference_invalid", "Alarm does not belong to the active Life.");
            if (action.kind === "alarm.cancel" && row === undefined) throw new DomainError("action_reference_invalid", "Alarm was not found.");
          }
        }
        if (action.kind === "delegate") {
          const agentConnectionId = actionText(action, "agentConnectionId");
          const row = asRow(this.database.prepare(`
            SELECT a.status
              FROM life_agent_bindings b JOIN agent_connections a ON a.agent_connection_id = b.agent_connection_id
             WHERE b.life_id = ? AND b.agent_connection_id = ? AND b.role = 'COLLABORATOR'`)
            .get(wake.lifeId, agentConnectionId));
          if (row === undefined || !new Set(["ACTIVE", "COLLABORATOR_ONLY"]).has(textValue(row, "status"))) {
            throw new DomainError("action_reference_invalid", "Delegate Agent is not an available collaborator for this Life.");
          }
          const artifactIds = Array.isArray(action.artifactIds) ? action.artifactIds as string[] : [];
          for (const artifactId of artifactIds) {
            const artifact = asRow(this.database.prepare(`
              SELECT life_id, relative_path, sha256 FROM artifacts WHERE artifact_id = ?`).get(artifactId));
            if (artifact === undefined || optionalTextValue(artifact, "life_id") !== wake.lifeId
              || optionalTextValue(artifact, "relative_path") === undefined || optionalTextValue(artifact, "sha256") === undefined) {
              throw new DomainError("action_reference_invalid", "A delegated Artifact is unavailable or belongs to another Life.");
            }
          }
        }
        if (action.kind === "interaction.answer") {
          const row = asRow(this.database.prepare(`
            SELECT COALESCE(d.life_id, w.life_id) AS life_id, i.status, i.kind
              FROM interactions i
              JOIN invocations v ON v.invocation_id = i.invocation_id
              LEFT JOIN delegations d ON d.invocation_id = v.invocation_id
              LEFT JOIN wake_turns wt ON wt.invocation_id = v.invocation_id
              LEFT JOIN wakes w ON w.wake_id = wt.wake_id
             WHERE i.interaction_id = ?`).get(actionText(action, "interactionId")));
          if (row === undefined || optionalTextValue(row, "life_id") !== wake.lifeId || textValue(row, "status") !== "PENDING"
            || textValue(row, "kind") === "auth-required") {
            throw new DomainError("action_reference_invalid", "Interaction is stale or does not belong to the active Life.");
          }
        }
      }
      const envelopeHash = this.createManifestHash(input.envelope);
      const existingSet = asRow(this.database.prepare(`
        SELECT envelope_hash FROM wake_action_sets WHERE wake_id = ? AND action_set_id = ?`)
        .get(input.wakeId, input.envelope.actionSetId));
      if (existingSet !== undefined) {
        if (textValue(existingSet, "envelope_hash") !== envelopeHash) {
          throw new DomainError("action_set_conflict", "Action set id was already used for a different envelope.");
        }
        return { expressions: this.listExpressionsForWakeSync(input.wakeId), sse: [], state: "RUNNING" };
      }
      const continueWake = input.envelope.continueWake && input.forceSleep !== true;
      this.database.prepare(`
        INSERT INTO wake_action_sets (wake_id, action_set_id, envelope_hash, continue_wake, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(input.wakeId, input.envelope.actionSetId, envelopeHash, continueWake ? 1 : 0, input.now);
      const expressions: ExpressionRecord[] = [];
      const sse: SseEvent[] = [];
      for (const action of input.envelope.actions) {
        let result: Record<string, unknown> = { accepted: true };
        switch (action.kind) {
          case "express":
            result = { expressionId: `expression_${action.actionId}` };
            break;
          case "affair.upsert": {
            const affairId = optionalActionText(action, "affairId") ?? `affair_${action.actionId}`;
            this.database.prepare(`
              INSERT INTO affairs (affair_id, life_id, title, status, waiting_reason, summary, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(affair_id) DO UPDATE SET
                title = excluded.title, status = excluded.status, waiting_reason = excluded.waiting_reason,
                summary = excluded.summary, updated_at = excluded.updated_at`)
              .run(affairId, wake.lifeId, actionText(action, "title"), optionalActionText(action, "status") ?? "OPEN",
                optionalActionText(action, "waitingReason") ?? null, optionalActionText(action, "summary") ?? null,
                input.now, input.now);
            result = { affairId };
            break;
          }
          case "todo.upsert": {
            const todoId = optionalActionText(action, "todoId") ?? `todo_${action.actionId}`;
            this.database.prepare(`
              INSERT INTO todos (todo_id, life_id, affair_id, title, status, due_at, assignee, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(todo_id) DO UPDATE SET
                affair_id = excluded.affair_id, title = excluded.title, status = excluded.status,
                due_at = excluded.due_at, assignee = excluded.assignee, updated_at = excluded.updated_at`)
              .run(todoId, wake.lifeId, optionalActionText(action, "affairId") ?? null, actionText(action, "title"),
                optionalActionText(action, "status") ?? "OPEN", optionalActionText(action, "dueAt") ?? null,
                optionalActionText(action, "assignee") ?? null, input.now, input.now);
            result = { todoId };
            break;
          }
          case "alarm.schedule": {
            const alarmId = optionalActionText(action, "alarmId") ?? `alarm_${action.actionId}`;
            const repeatEveryMinutes = action.repeatEveryMinutes;
            this.database.prepare(`
              INSERT INTO alarms (alarm_id, life_id, affair_id, reason, next_at, repeat_every_minutes, creator, allow_quiet_hours, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SCHEDULED', ?, ?)
              ON CONFLICT(alarm_id) DO UPDATE SET
                affair_id = excluded.affair_id, reason = excluded.reason, next_at = excluded.next_at,
                repeat_every_minutes = excluded.repeat_every_minutes, creator = excluded.creator,
                allow_quiet_hours = excluded.allow_quiet_hours,
                status = 'SCHEDULED', updated_at = excluded.updated_at`)
              .run(alarmId, wake.lifeId, optionalActionText(action, "affairId") ?? null, actionText(action, "reason"),
                actionText(action, "at"), typeof repeatEveryMinutes === "number" ? repeatEveryMinutes : null,
                optionalActionText(action, "creator") ?? "AGENT",
                action.allowQuietHours === true ? 1 : 0, input.now, input.now);
            this.database.prepare("UPDATE alarms SET recurrence_rule = ? WHERE alarm_id = ?")
              .run(optionalActionText(action, "recurrenceRule") ?? null, alarmId);
            result = { alarmId };
            break;
          }
          case "alarm.cancel": {
            const alarmId = actionText(action, "alarmId");
            this.database.prepare("UPDATE alarms SET status = 'CANCELED', updated_at = ? WHERE alarm_id = ? AND life_id = ?")
              .run(input.now, alarmId, wake.lifeId);
            result = { alarmId };
            break;
          }
          case "memory.append": {
            const memoryId = `memory_${action.actionId}`;
            const confidence = action.confidence;
            this.database.prepare(`
              INSERT OR IGNORE INTO memory_fragments
                (memory_id, life_id, affair_id, kind, content, confidence, source_event_id, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
              .run(memoryId, wake.lifeId, optionalActionText(action, "affairId") ?? null,
                optionalActionText(action, "memoryKind") ?? "EPISODIC", actionText(action, "content"),
                typeof confidence === "number" ? confidence : 0.7, optionalActionText(action, "sourceEventId") ?? null,
                input.now, input.now);
            this.persistMemoryEntities(memoryId, wake.lifeId, action, input.now);
            result = { memoryId };
            break;
          }
          case "memory.revise": {
            const memoryId = actionText(action, "memoryId");
            const row = asRow(this.database.prepare("SELECT content, revision FROM memory_fragments WHERE memory_id = ?").get(memoryId));
            if (row === undefined) throw new DomainError("action_reference_invalid", "Memory was not found.");
            const revision = numberValue(row, "revision") + 1;
            const content = actionText(action, "content");
            this.database.prepare(`
              INSERT INTO memory_revisions
                (memory_revision_id, memory_id, revision, previous_content, new_content, source_wake_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
              .run(`memory_revision_${action.actionId}`, memoryId, revision, textValue(row, "content"), content, wake.wakeId, input.now);
            this.database.prepare(`
              UPDATE memory_fragments SET content = ?, confidence = COALESCE(?, confidence), revision = ?, updated_at = ?
               WHERE memory_id = ?`)
              .run(content, typeof action.confidence === "number" ? action.confidence : null, revision, input.now, memoryId);
            if (Array.isArray(action.entities)) {
              this.database.prepare("DELETE FROM memory_entity_links WHERE memory_id = ?").run(memoryId);
              this.persistMemoryEntities(memoryId, wake.lifeId, action, input.now);
            }
            result = { memoryId, revision };
            break;
          }
          case "delegate": {
            const delegationId = `delegation_${action.actionId}`;
            this.database.prepare(`
              INSERT INTO delegations
                (delegation_id, life_id, affair_id, agent_connection_id, source_wake_id, title, task, status, created_at, updated_at, artifact_ids_json)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`)
              .run(delegationId, wake.lifeId, optionalActionText(action, "affairId") ?? null,
                actionText(action, "agentConnectionId"), wake.wakeId,
                optionalActionText(action, "title") ?? actionText(action, "task").slice(0, 120),
                actionText(action, "task"), input.now, input.now, JSON.stringify(Array.isArray(action.artifactIds) ? action.artifactIds : []));
            this.database.prepare(`
              INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
              VALUES (?, 'delegation.send', ?, 'PENDING', 0, ?, ?)`)
              .run(`outbox_${delegationId}`, JSON.stringify({ delegationId }), input.now, input.now);
            result = { delegationId };
            break;
          }
          case "interaction.answer": {
            const interactionId = actionText(action, "interactionId");
            this.database.prepare(`
              INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
              VALUES (?, 'interaction.answer', ?, 'PENDING', 0, ?, ?)`)
              .run(`outbox_interaction_${action.actionId}`, JSON.stringify({ answer: actionText(action, "answer"), interactionId }), input.now, input.now);
            result = { interactionId };
            break;
          }
        }
        const insertion = this.database.prepare(`
          INSERT OR IGNORE INTO life_actions
            (life_action_id, wake_id, action_id, action_set_id, action_kind, payload_json, result_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`life_action_${input.wakeId}_${action.actionId}`, input.wakeId, action.actionId,
            input.envelope.actionSetId, action.kind, JSON.stringify(action), JSON.stringify(result), input.now);
        if (action.kind === "express") {
          const text = action.text;
          if (typeof text !== "string") throw new DomainError("action_schema_invalid", "express text is invalid.");
          const deliverAfter = input.expressionDeliverAfter ?? input.now;
          const deliveredAt = deliverAfter <= input.now ? input.now : null;
          this.database.prepare(`
            INSERT OR IGNORE INTO expressions
              (expression_id, life_id, wake_id, action_id, text, created_at, deliver_after, delivered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(`expression_${action.actionId}`, wake.lifeId, input.wakeId, action.actionId, text, input.now, deliverAfter, deliveredAt);
          const expressionRow = asRow(this.database.prepare("SELECT * FROM expressions WHERE wake_id = ? AND action_id = ?")
            .get(input.wakeId, action.actionId));
          if (expressionRow !== undefined) expressions.push(mapExpression(expressionRow));
          if (insertion.changes > 0 && deliveredAt !== null) {
            sse.push(this.appendSseEventSync({
              entityId: wake.lifeId,
              payload: { actionId: action.actionId, expressionId: `expression_${action.actionId}`, lifeId: wake.lifeId, text },
              type: "expression.created",
            }, input.now));
          }
        }
      }
      this.database.prepare(`
        INSERT INTO consciousness_residue (life_id, wake_id, text, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(life_id) DO UPDATE SET wake_id = excluded.wake_id, text = excluded.text, updated_at = excluded.updated_at`)
        .run(wake.lifeId, input.wakeId, input.envelope.consciousnessResidue, input.now);
      this.database.prepare(`
        UPDATE life_events SET status = 'CONSUMED', consumed_at = ?
         WHERE claimed_by_wake_id = ? AND status = 'CLAIMED'`).run(input.now, input.wakeId);
      this.insertFlowEventSync(input.wakeId, "ActionsCommitted", wake.lifeId,
        { actionCount: input.envelope.actions.length, continueWake }, input.now);
      if (continueWake) {
        return { expressions, sse, state: "RUNNING" };
      }
      this.database.prepare(`UPDATE wakes SET status = 'COMPLETED', ended_at = ?, updated_at = ? WHERE wake_id = ?`)
        .run(input.now, input.now, input.wakeId);
      this.database.prepare("DELETE FROM runtime_leases WHERE resource_type = 'life' AND resource_id = ? AND owner = ? AND generation = ?")
        .run(wake.lifeId, wake.leaseOwner, wake.leaseGeneration);
      this.database.prepare("UPDATE lives SET state = 'SLEEPING', updated_at = ?, protocol_failure_count = 0 WHERE life_id = ?")
        .run(input.now, wake.lifeId);
      sse.push(this.appendSseEventSync({
        entityId: input.wakeId,
        payload: { lifeId: wake.lifeId, status: "COMPLETED", wakeId: input.wakeId },
        type: "wake.changed",
      }, input.now));
      sse.push(this.appendSseEventSync({
        entityId: wake.lifeId,
        payload: { lifeId: wake.lifeId, state: "SLEEPING" },
        type: "life.state.changed",
      }, input.now));
      return { expressions, sse, state: "SLEEPING" };
    });
  }

  async listWakeActions(wakeId: string): Promise<WakeActionRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM life_actions WHERE wake_id = ? ORDER BY created_at, action_id").all(wakeId)).map(mapWakeAction);
  }

  async listExpressions(lifeId: string): Promise<ExpressionRecord[]> {
    return asRows(this.database.prepare(`
      SELECT * FROM expressions WHERE life_id = ? AND delivered_at IS NOT NULL ORDER BY delivered_at, expression_id`).all(lifeId)).map(mapExpression);
  }

  async getConsciousnessResidue(lifeId: string): Promise<{ text: string; updatedAt: string; wakeId: string } | null> {
    const row = asRow(this.database.prepare("SELECT * FROM consciousness_residue WHERE life_id = ?").get(lifeId));
    return row === undefined ? null : {
      text: textValue(row, "text"), updatedAt: textValue(row, "updated_at"), wakeId: textValue(row, "wake_id"),
    };
  }

  async bindCollaborator(lifeId: string, agentConnectionId: string, now: string): Promise<void> {
    const life = this.getLifeSync(lifeId);
    if (life === null) throw new DomainError("life_not_found", "Life was not found.");
    const agent = await this.getPublicAgentConnection(agentConnectionId);
    if (agent === null) throw new DomainError("agent_not_found", "Agent connection was not found.");
    this.database.prepare(`
      INSERT INTO life_agent_bindings (life_id, agent_connection_id, role, created_at)
      VALUES (?, ?, 'COLLABORATOR', ?)
      ON CONFLICT(life_id, agent_connection_id) DO UPDATE SET role = 'COLLABORATOR'`)
      .run(lifeId, agentConnectionId, now);
  }

  async unbindCollaborator(lifeId: string, agentConnectionId: string): Promise<boolean> {
    return this.database.prepare(`
      DELETE FROM life_agent_bindings WHERE life_id = ? AND agent_connection_id = ? AND role = 'COLLABORATOR'`)
      .run(lifeId, agentConnectionId).changes === 1;
  }

  async listAffairs(lifeId: string): Promise<AffairRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM affairs WHERE life_id = ? ORDER BY updated_at DESC, affair_id").all(lifeId)).map(mapAffair);
  }

  async listTodos(lifeId: string): Promise<TodoRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM todos WHERE life_id = ? ORDER BY due_at IS NULL, due_at, todo_id").all(lifeId)).map(mapTodo);
  }

  async listAlarms(lifeId: string): Promise<AlarmRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM alarms WHERE life_id = ? ORDER BY next_at, alarm_id").all(lifeId)).map(mapAlarm);
  }

  async listDueAlarms(now: string, limit: number): Promise<AlarmRecord[]> {
    return asRows(this.database.prepare(`
      SELECT * FROM alarms WHERE status = 'SCHEDULED' AND next_at <= ? ORDER BY next_at, alarm_id LIMIT ?`)
      .all(now, Math.max(1, Math.min(limit, 100)))).map(mapAlarm);
  }

  async deferAlarmForQuietHours(input: { alarmId: string; expectedNextAt: string; nextAt: string; now: string }): Promise<boolean> {
    return this.database.prepare(`
      UPDATE alarms SET next_at = ?, updated_at = ?
       WHERE alarm_id = ? AND next_at = ? AND status = 'SCHEDULED'`)
      .run(input.nextAt, input.now, input.alarmId, input.expectedNextAt).changes === 1;
  }

  async listDueTodos(now: string, limit: number): Promise<TodoRecord[]> {
    return asRows(this.database.prepare(`
      SELECT t.* FROM todos t
       WHERE t.status IN ('OPEN', 'IN_PROGRESS') AND t.due_at IS NOT NULL AND t.due_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM todo_occurrences o WHERE o.todo_id = t.todo_id AND o.occurrence_at = t.due_at
         )
       ORDER BY t.due_at, t.todo_id LIMIT ?`)
      .all(now, Math.max(1, Math.min(limit, 100)))).map(mapTodo);
  }

  async listMemories(lifeId: string): Promise<MemoryRecord[]> {
    return this.withMemoryEntities(asRows(this.database.prepare(
      "SELECT * FROM memory_fragments WHERE life_id = ? ORDER BY updated_at DESC, memory_id").all(lifeId)).map(mapMemory));
  }

  async listSchedules(lifeId: string): Promise<ScheduleRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM schedules WHERE life_id = ? ORDER BY local_time, schedule_id").all(lifeId)).map(mapSchedule);
  }

  async listEnabledSchedules(): Promise<ScheduleRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM schedules WHERE enabled = 1 ORDER BY life_id, local_time, schedule_id").all()).map(mapSchedule);
  }

  async updateSchedule(input: { enabled: boolean; lifeId: string; localTime: string; now: string; scheduleId: string }): Promise<{ event: SseEvent; schedule: ScheduleRecord } | null> {
    return this.inTransaction(() => {
      const result = this.database.prepare(`
        UPDATE schedules SET local_time = ?, enabled = ?, last_fired_local_date = NULL, updated_at = ?
         WHERE schedule_id = ? AND life_id = ?`)
        .run(input.localTime, input.enabled ? 1 : 0, input.now, input.scheduleId, input.lifeId);
      if (result.changes === 0) return null;
      const row = asRow(this.database.prepare("SELECT * FROM schedules WHERE schedule_id = ?").get(input.scheduleId));
      if (row === undefined) throw new Error("Schedule disappeared during update.");
      const event = this.appendSseEventSync({
        entityId: input.lifeId,
        payload: { enabled: input.enabled, lifeId: input.lifeId, localTime: input.localTime, scheduleId: input.scheduleId },
        type: "schedule.updated",
      }, input.now);
      return { event, schedule: mapSchedule(row) };
    });
  }

  async listDelegations(lifeId: string): Promise<DelegationRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM delegations WHERE life_id = ? ORDER BY created_at DESC, delegation_id").all(lifeId)).map(mapDelegation);
  }

  async getDelegation(delegationId: string): Promise<DelegationRecord | null> {
    const row = asRow(this.database.prepare("SELECT * FROM delegations WHERE delegation_id = ?").get(delegationId));
    return row === undefined ? null : mapDelegation(row);
  }

  async updateDelegation(input: { delegationId: string; invocationId?: string; now: string; status: DelegationRecord["status"] }): Promise<DelegationRecord> {
    const result = this.database.prepare(`
      UPDATE delegations SET status = ?, invocation_id = COALESCE(?, invocation_id), updated_at = ? WHERE delegation_id = ?`)
      .run(input.status, input.invocationId ?? null, input.now, input.delegationId);
    if (result.changes === 0) throw new DomainError("delegation_not_found", "Delegation was not found.");
    const delegation = await this.getDelegation(input.delegationId);
    if (delegation === null) throw new Error("Delegation disappeared during update.");
    return delegation;
  }

  async listLifeCollaborators(lifeId: string): Promise<PublicAgentConnection[]> {
    return asRows(this.database.prepare(`
      SELECT a.agent_connection_id, a.name, a.description, a.skills_json, a.readiness,
             a.credential_version, a.status, a.updated_at
        FROM life_agent_bindings b
        JOIN agent_connections a ON a.agent_connection_id = b.agent_connection_id
       WHERE b.life_id = ? AND b.role = 'COLLABORATOR'
       ORDER BY a.name, a.agent_connection_id`).all(lifeId)).map(mapPublicAgent);
  }

  async getDailyBudget(lifeId: string, localDate: string, now: string): Promise<DailyBudgetRecord> {
    this.database.prepare(`
      INSERT INTO daily_budgets
        (life_id, local_date, autonomous_wakes_limit, invocations_limit, idle_explorations_limit, updated_at)
      SELECT life_id, ?, autonomous_wakes_default, invocations_default, idle_explorations_default, ?
        FROM lives WHERE life_id = ?
      ON CONFLICT(life_id, local_date) DO NOTHING`).run(localDate, now, lifeId);
    const row = asRow(this.database.prepare("SELECT * FROM daily_budgets WHERE life_id = ? AND local_date = ?").get(lifeId, localDate));
    if (row === undefined) throw new DomainError("life_not_found", "Life was not found.");
    return {
      autonomousWakesLimit: numberValue(row, "autonomous_wakes_limit"),
      autonomousWakesUsed: numberValue(row, "autonomous_wakes_used"),
      idleExplorationsLimit: numberValue(row, "idle_explorations_limit"),
      idleExplorationsUsed: numberValue(row, "idle_explorations_used"),
      invocationsLimit: numberValue(row, "invocations_limit"),
      invocationsUsed: numberValue(row, "invocations_used"),
      lifeId,
      localDate,
    };
  }

  async extendDailyBudget(input: { autonomousWakes: number; invocations: number; lifeId: string; localDate: string; now: string }): Promise<DailyBudgetRecord> {
    await this.getDailyBudget(input.lifeId, input.localDate, input.now);
    this.database.prepare(`
      UPDATE daily_budgets
         SET autonomous_wakes_limit = autonomous_wakes_limit + ?, invocations_limit = invocations_limit + ?, updated_at = ?
       WHERE life_id = ? AND local_date = ?`)
      .run(Math.max(0, input.autonomousWakes), Math.max(0, input.invocations), input.now, input.lifeId, input.localDate);
    return this.getDailyBudget(input.lifeId, input.localDate, input.now);
  }

  async recallMemories(input: { affairId?: string; lifeId: string; limit: number; now: string; query: string }): Promise<MemoryRecord[]> {
    const tokens = memoryQueryTokens(input.query);
    let rows = tokens.length === 0
      ? asRows(this.database.prepare(`
          SELECT * FROM memory_fragments
           WHERE life_id = ? AND status = 'ACTIVE'
           ORDER BY kind = 'CARD' DESC, confidence DESC, updated_at DESC LIMIT ?`)
        .all(input.lifeId, Math.max(1, Math.min(input.limit, 16))))
      : asRows(this.database.prepare(`
          SELECT m.*
            FROM memory_fragments_fts f
            JOIN memory_fragments m ON m.rowid = f.rowid
           WHERE memory_fragments_fts MATCH ? AND m.life_id = ? AND m.status = 'ACTIVE'
           ORDER BY m.kind = 'CARD' DESC, m.affair_id = ? DESC, bm25(memory_fragments_fts), m.confidence DESC
           LIMIT ?`).all(tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR "), input.lifeId,
          input.affairId ?? "", Math.max(1, Math.min(input.limit, 16))));
    if (tokens.length > 0 && rows.length === 0) {
      const clauses = tokens.map(() => "content LIKE ?").join(" OR ");
      rows = asRows(this.database.prepare(`
        SELECT * FROM memory_fragments
         WHERE life_id = ? AND status = 'ACTIVE' AND (${clauses})
         ORDER BY kind = 'CARD' DESC, affair_id = ? DESC, confidence DESC, updated_at DESC
         LIMIT ?`).all(input.lifeId, ...tokens.map((token) => `%${token}%`), input.affairId ?? "",
          Math.max(1, Math.min(input.limit, 16))));
    }
    if (tokens.length > 0) {
      const entityClauses = tokens.map(() => "e.normalized_name LIKE ?").join(" OR ");
      const entityRows = asRows(this.database.prepare(`
        SELECT DISTINCT m.*
          FROM memory_fragments m
          JOIN memory_entity_links l ON l.memory_id = m.memory_id
          JOIN memory_entities e ON e.entity_id = l.entity_id
         WHERE m.life_id = ? AND m.status = 'ACTIVE' AND (${entityClauses})
         ORDER BY m.kind = 'CARD' DESC, m.affair_id = ? DESC, m.confidence DESC, m.updated_at DESC
         LIMIT ?`).all(input.lifeId, ...tokens.map((token) => `%${token.normalize("NFKC").toLocaleLowerCase()}%`),
          input.affairId ?? "", Math.max(1, Math.min(input.limit, 16))));
      const byId = new Map<string, Row>();
      for (const row of [...entityRows, ...rows]) byId.set(textValue(row, "memory_id"), row);
      rows = [...byId.values()].slice(0, Math.max(1, Math.min(input.limit, 16)));
    }
    const touch = this.database.prepare("UPDATE memory_fragments SET last_accessed_at = ? WHERE memory_id = ?");
    for (const row of rows) touch.run(input.now, textValue(row, "memory_id"));
    return this.withMemoryEntities(rows.map(mapMemory));
  }

  async deliverDueExpressions(now: string, limit: number): Promise<{ expressions: ExpressionRecord[]; sse: SseEvent[] }> {
    return this.inTransaction(() => {
      const rows = asRows(this.database.prepare(`
        SELECT * FROM expressions
         WHERE delivered_at IS NULL AND deliver_after <= ?
         ORDER BY deliver_after, expression_id LIMIT ?`).all(now, Math.max(1, Math.min(limit, 100))));
      const expressions: ExpressionRecord[] = [];
      const sse: SseEvent[] = [];
      const deliver = this.database.prepare(`
        UPDATE expressions SET delivered_at = ? WHERE expression_id = ? AND delivered_at IS NULL`);
      for (const row of rows) {
        const expression = mapExpression(row);
        if (deliver.run(now, expression.expressionId).changes === 0) continue;
        expressions.push({ ...expression, deliveredAt: now });
        sse.push(this.appendSseEventSync({
          entityId: expression.lifeId,
          payload: {
            actionId: expression.actionId,
            expressionId: expression.expressionId,
            lifeId: expression.lifeId,
            text: expression.text,
          },
          type: "expression.created",
        }, now));
      }
      return { expressions, sse };
    });
  }

  async fireTodoOccurrence(input: {
    event: CreateLifeEventRecord;
    now: string;
    occurrenceAt: string;
    todoId: string;
  }): Promise<{ created: boolean; event: LifeEvent | null; sse: SseEvent[] }> {
    return this.inTransaction(() => {
      const existing = asRow(this.database.prepare(`
        SELECT event_id FROM todo_occurrences WHERE todo_id = ? AND occurrence_at = ?`)
        .get(input.todoId, input.occurrenceAt));
      if (existing !== undefined) {
        return { created: false, event: this.getLifeEventSync(textValue(existing, "event_id")), sse: [] };
      }
      const todoRow = asRow(this.database.prepare(`
        SELECT * FROM todos WHERE todo_id = ? AND status IN ('OPEN', 'IN_PROGRESS')`).get(input.todoId));
      if (todoRow === undefined) return { created: false, event: null, sse: [] };
      const todo = mapTodo(todoRow);
      if (todo.lifeId !== input.event.lifeId || todo.dueAt !== input.occurrenceAt) {
        throw new DomainError("todo_occurrence_invalid", "Todo occurrence does not match its current due time.");
      }
      this.insertLifeEventSync(input.event);
      this.database.prepare(`
        INSERT INTO todo_occurrences (todo_id, occurrence_at, event_id, created_at) VALUES (?, ?, ?, ?)`)
        .run(input.todoId, input.occurrenceAt, input.event.eventId, input.now);
      const event = this.getLifeEventSync(input.event.eventId);
      if (event === null) throw new Error("Todo event disappeared during occurrence transaction.");
      const sse = this.appendSseEventSync({
        entityId: todo.lifeId,
        payload: { eventId: event.eventId, lifeId: todo.lifeId, occurrenceAt: input.occurrenceAt, todoId: todo.todoId },
        type: "event.created",
      }, input.now);
      return { created: true, event, sse: [sse] };
    });
  }

  async fireAlarmOccurrence(input: {
    alarmId: string;
    event: CreateLifeEventRecord;
    now: string;
    occurrenceAt: string;
    occurrenceId: string;
  }): Promise<{ created: boolean; event: LifeEvent | null; sse: SseEvent[] }> {
    return this.inTransaction(() => {
      const existing = asRow(this.database.prepare(`
        SELECT event_id FROM alarm_occurrences WHERE alarm_id = ? AND occurrence_at = ?`)
        .get(input.alarmId, input.occurrenceAt));
      if (existing !== undefined) {
        return { created: false, event: this.getLifeEventSync(textValue(existing, "event_id")), sse: [] };
      }
      const alarmRow = asRow(this.database.prepare("SELECT * FROM alarms WHERE alarm_id = ? AND status = 'SCHEDULED'").get(input.alarmId));
      if (alarmRow === undefined) return { created: false, event: null, sse: [] };
      const alarm = mapAlarm(alarmRow);
      if (alarm.lifeId !== input.event.lifeId || alarm.nextAt !== input.occurrenceAt) {
        throw new DomainError("alarm_occurrence_invalid", "Alarm occurrence does not match its current schedule.");
      }
      this.insertLifeEventSync(input.event);
      this.database.prepare(`
        INSERT INTO alarm_occurrences (occurrence_id, alarm_id, life_id, occurrence_at, event_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(input.occurrenceId, input.alarmId, alarm.lifeId, input.occurrenceAt, input.event.eventId, input.now);
      if (alarm.repeatEveryMinutes === undefined && alarm.recurrenceRule === undefined) {
        this.database.prepare("UPDATE alarms SET status = 'FIRED', updated_at = ? WHERE alarm_id = ?").run(input.now, input.alarmId);
      } else {
        const life = this.getLifeSync(alarm.lifeId);
        if (life === null) throw new Error("Alarm Life disappeared while advancing recurrence.");
        const nextAt = alarm.recurrenceRule === undefined
          ? new Date(Date.parse(input.occurrenceAt) + (alarm.repeatEveryMinutes ?? 0) * 60_000).toISOString()
          : new RhythmPolicy().nextCalendarAlarm(new Date(input.occurrenceAt), life.timezone, alarm.recurrenceRule).toISOString();
        this.database.prepare("UPDATE alarms SET next_at = ?, updated_at = ? WHERE alarm_id = ?").run(nextAt, input.now, input.alarmId);
      }
      const event = this.getLifeEventSync(input.event.eventId);
      if (event === null) throw new Error("Alarm event disappeared during occurrence transaction.");
      const sse = this.appendSseEventSync({
        entityId: alarm.lifeId,
        payload: { alarmId: alarm.alarmId, eventId: event.eventId, lifeId: alarm.lifeId, occurrenceAt: input.occurrenceAt },
        type: "event.created",
      }, input.now);
      return { created: true, event, sse: [sse] };
    });
  }

  async fireSchedule(input: { event: CreateLifeEventRecord; localDate: string; now: string; scheduleId: string }): Promise<{ created: boolean; event: LifeEvent | null; sse: SseEvent[] }> {
    return this.inTransaction(() => {
      const schedule = asRow(this.database.prepare("SELECT life_id, last_fired_local_date FROM schedules WHERE schedule_id = ? AND enabled = 1").get(input.scheduleId));
      if (schedule === undefined || optionalTextValue(schedule, "last_fired_local_date") === input.localDate) {
        return { created: false, event: null, sse: [] };
      }
      if (textValue(schedule, "life_id") !== input.event.lifeId) throw new DomainError("schedule_event_invalid", "Schedule event Life does not match.");
      this.insertLifeEventSync(input.event);
      this.database.prepare("UPDATE schedules SET last_fired_local_date = ?, updated_at = ? WHERE schedule_id = ?")
        .run(input.localDate, input.now, input.scheduleId);
      const event = this.getLifeEventSync(input.event.eventId);
      if (event === null) throw new Error("Schedule event disappeared during transaction.");
      const sse = this.appendSseEventSync({
        entityId: input.event.lifeId,
        payload: { eventId: event.eventId, lifeId: input.event.lifeId, scheduleId: input.scheduleId, type: event.type },
        type: "event.created",
      }, input.now);
      return { created: true, event, sse: [sse] };
    });
  }

  async createAgentConnection(connection: AgentConnection): Promise<void> {
    this.database.prepare(`
      INSERT INTO agent_connections (agent_connection_id, name, card_url, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(connection.agentConnectionId, connection.name, connection.cardUrl, connection.status, connection.createdAt, connection.updatedAt);
  }

  async getAgentConnection(agentConnectionId: string): Promise<AgentConnection | null> {
    const row = asRow(this.database.prepare("SELECT * FROM agent_connections WHERE agent_connection_id = ? AND deleted_at IS NULL").get(agentConnectionId));
    return row === undefined ? null : mapAgent(row);
  }

  async listPublicAgentConnections(): Promise<PublicAgentConnection[]> {
    const connections = asRows(this.database.prepare(`
      SELECT agent_connection_id, name, description, skills_json, readiness, credential_version, status, token_required, updated_at
        FROM agent_connections WHERE deleted_at IS NULL ORDER BY created_at DESC, agent_connection_id DESC`).all()).map(mapPublicAgent);
    return connections.map((connection) => ({ ...connection, ...this.agentUsage(connection.agentConnectionId) }));
  }

  async getPublicAgentConnection(agentConnectionId: string): Promise<PublicAgentConnection | null> {
    const row = asRow(this.database.prepare(`
      SELECT agent_connection_id, name, description, skills_json, readiness, credential_version, status, token_required, updated_at
        FROM agent_connections WHERE agent_connection_id = ? AND deleted_at IS NULL`).get(agentConnectionId));
    return row === undefined ? null : { ...mapPublicAgent(row), ...this.agentUsage(agentConnectionId) };
  }

  async updateAgentConnectionStatus(agentConnectionId: string, status: AgentConnectionStatus, now: string): Promise<AgentConnection | null> {
    const result = this.database.prepare("UPDATE agent_connections SET status = ?, updated_at = ? WHERE agent_connection_id = ? AND deleted_at IS NULL")
      .run(status, now, agentConnectionId);
    if (result.changes === 0) return null;
    return this.getAgentConnection(agentConnectionId);
  }

  async findAgentConnectionByCardUrlHash(cardUrlHash: string): Promise<AgentIntegrationRecord | null> {
    const row = asRow(this.database.prepare("SELECT agent_connection_id FROM agent_connections WHERE card_url_hash = ? AND deleted_at IS NULL").get(cardUrlHash));
    return row === undefined ? null : this.getAgentIntegrationRecordSync(textValue(row, "agent_connection_id"));
  }

  async getAgentIntegrationRecord(agentConnectionId: string): Promise<AgentIntegrationRecord | null> {
    return this.getAgentIntegrationRecordSync(agentConnectionId);
  }

  async saveOnboardedAgent(input: SaveOnboardedAgentInput): Promise<PublicAgentConnection> {
    return this.inTransaction(() => {
      const existing = asRow(this.database.prepare("SELECT credential_id, created_at FROM agent_connections WHERE agent_connection_id = ?")
        .get(input.agentConnectionId));
      const oldCredentialId = existing === undefined ? undefined : optionalTextValue(existing, "credential_id");
      const createdAt = existing === undefined ? input.now : textValue(existing, "created_at");
      this.database.prepare(`
        INSERT INTO agent_credentials (credential_id, encrypted_blob, credential_version, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(credential_id) DO UPDATE SET
          encrypted_blob = excluded.encrypted_blob,
          credential_version = excluded.credential_version,
          created_at = excluded.created_at`)
        .run(input.credentialId, input.encryptedCredential, input.credentialVersion, input.now);
      this.upsertAgentConnection(input, createdAt);
      this.insertCardSnapshot(input.agentConnectionId, input.cardSnapshotId, input.card, input.now);
      this.database.prepare(`
        UPDATE agent_connections SET card_snapshot_id = ? WHERE agent_connection_id = ?`)
        .run(input.cardSnapshotId, input.agentConnectionId);
      if (oldCredentialId !== undefined && oldCredentialId !== input.credentialId) {
        this.database.prepare("DELETE FROM agent_credentials WHERE credential_id = ?").run(oldCredentialId);
      }
      const row = asRow(this.database.prepare(`
        SELECT agent_connection_id, name, description, skills_json, readiness, credential_version, status, token_required, updated_at
          FROM agent_connections WHERE agent_connection_id = ?`).get(input.agentConnectionId));
      if (row === undefined) throw new Error("Onboarded Agent could not be read back.");
      return mapPublicAgent(row);
    });
  }

  async markAgentCardDrift(input: { agentConnectionId: string; candidate: AgentCardCandidate; cardSnapshotId: string; now: string }): Promise<PublicAgentConnection> {
    return this.inTransaction(() => {
      this.insertCardSnapshot(input.agentConnectionId, input.cardSnapshotId, input.candidate, input.now);
      this.database.prepare(`
        UPDATE agent_connections
           SET status = 'RECONFIRM_REQUIRED', updated_at = ?, last_validated_at = ?
         WHERE agent_connection_id = ?`)
        .run(input.now, input.now, input.agentConnectionId);
      const row = asRow(this.database.prepare(`
        SELECT agent_connection_id, name, description, skills_json, readiness, credential_version, status, token_required, updated_at
          FROM agent_connections WHERE agent_connection_id = ?`).get(input.agentConnectionId));
      if (row === undefined) throw new Error("Agent connection disappeared during Card refresh.");
      return mapPublicAgent(row);
    });
  }

  async getConnectionBreaker(breakerKey: string): Promise<ConnectionBreakerRecord | null> {
    const row = asRow(this.database.prepare("SELECT * FROM connection_breakers WHERE breaker_key = ?").get(breakerKey));
    if (row === undefined) return null;
    return {
      breakerKey: textValue(row, "breaker_key"),
      lastStatus: numberValue(row, "last_status") as 429 | 503,
      openUntil: textValue(row, "open_until"),
      updatedAt: textValue(row, "updated_at"),
    };
  }

  async saveConnectionBreaker(record: ConnectionBreakerRecord): Promise<void> {
    this.database.prepare(`
      INSERT INTO connection_breakers (breaker_key, open_until, last_status, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(breaker_key) DO UPDATE SET
        open_until = CASE WHEN excluded.open_until > open_until THEN excluded.open_until ELSE open_until END,
        last_status = excluded.last_status,
        updated_at = excluded.updated_at`)
      .run(record.breakerKey, record.openUntil, record.lastStatus, record.updatedAt);
  }

  async setAgentIntegrationStatus(agentConnectionId: string, status: "DISABLED", now: string): Promise<PublicAgentConnection | null> {
    const result = this.database.prepare("UPDATE agent_connections SET status = ?, updated_at = ? WHERE agent_connection_id = ? AND deleted_at IS NULL")
      .run(status, now, agentConnectionId);
    if (result.changes === 0) return null;
    return this.getPublicAgentConnection(agentConnectionId);
  }

  async getAgentDeletionImpact(agentConnectionId: string): Promise<{ activeInvocations: number; bindings: { lifeId: string; name: string; role: "COLLABORATOR" | "PRIMARY" }[] } | null> {
    const connection = asRow(this.database.prepare("SELECT 1 AS found FROM agent_connections WHERE agent_connection_id = ? AND deleted_at IS NULL")
      .get(agentConnectionId));
    if (connection === undefined) return null;
    const bindings = asRows(this.database.prepare(`
      SELECT l.life_id, l.name, b.role FROM life_agent_bindings b JOIN lives l ON l.life_id = b.life_id
       WHERE b.agent_connection_id = ? ORDER BY l.name, l.life_id`).all(agentConnectionId)).map((row) => ({
      lifeId: textValue(row, "life_id"),
      name: textValue(row, "name"),
      role: textValue(row, "role") as "COLLABORATOR" | "PRIMARY",
    }));
    const active = asRow(this.database.prepare(`
      SELECT COUNT(*) AS count FROM invocations WHERE agent_connection_id = ?
       AND status NOT IN ('CANCELED', 'COMPLETED', 'FAILED', 'UNKNOWN_REQUIRES_REVIEW')`).get(agentConnectionId));
    return { activeInvocations: active === undefined ? 0 : numberValue(active, "count"), bindings };
  }

  async deleteAgentIntegration(agentConnectionId: string, now: string): Promise<boolean> {
    return this.inTransaction(() => {
      const impact = asRow(this.database.prepare(`
        SELECT credential_id,
          (SELECT COUNT(*) FROM life_agent_bindings WHERE agent_connection_id = a.agent_connection_id) AS bindings,
          (SELECT COUNT(*) FROM invocations WHERE agent_connection_id = a.agent_connection_id
            AND status NOT IN ('CANCELED', 'COMPLETED', 'FAILED', 'UNKNOWN_REQUIRES_REVIEW')) AS active_invocations
          FROM agent_connections a WHERE agent_connection_id = ? AND deleted_at IS NULL`).get(agentConnectionId));
      if (impact === undefined) return false;
      if (numberValue(impact, "bindings") > 0) throw new DomainError("agent_still_bound", "Agent must be unbound from every Life before deletion.");
      if (numberValue(impact, "active_invocations") > 0) throw new DomainError("agent_invocation_active", "Agent has an active invocation and cannot be deleted yet.");
      const credentialId = optionalTextValue(impact, "credential_id");
      this.database.prepare("DELETE FROM agent_card_snapshots WHERE agent_connection_id = ?").run(agentConnectionId);
      this.database.prepare(`
        UPDATE agent_connections SET name = 'Deleted Agent', card_url = 'https://deleted.invalid/', status = 'DISABLED', token_required = 0,
          description = NULL, skills_json = NULL, readiness = NULL, card_url_hash = NULL, credential_id = NULL,
          credential_version = NULL, card_snapshot_id = NULL, origin_hash = NULL, deleted_at = ?, updated_at = ?
         WHERE agent_connection_id = ?`).run(now, now, agentConnectionId);
      if (credentialId !== undefined) this.database.prepare("DELETE FROM agent_credentials WHERE credential_id = ?").run(credentialId);
      return true;
    });
  }

  async createInvocation(input: {
    agentConnectionId: string;
    createdAt: string;
    invocationId: string;
    messageId: string;
    outboxId: string;
    request: InvocationRecord["request"];
  }): Promise<InvocationRecord> {
    return this.inTransaction(() => {
      this.database.prepare(`
        INSERT INTO invocations
          (invocation_id, agent_connection_id, message_id, request_json, status, send_attempts,
           last_activity_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'CREATED', 0, ?, ?, ?)`)
        .run(input.invocationId, input.agentConnectionId, input.messageId, JSON.stringify(input.request),
          input.createdAt, input.createdAt, input.createdAt);
      this.database.prepare(`
        INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
        VALUES (?, 'a2a.send', ?, 'PENDING', 0, ?, ?)`)
        .run(input.outboxId, JSON.stringify({ invocationId: input.invocationId }), input.createdAt, input.createdAt);
      const row = asRow(this.database.prepare("SELECT * FROM invocations WHERE invocation_id = ?").get(input.invocationId));
      if (row === undefined) throw new Error("Invocation could not be read after creation.");
      return mapInvocation(row);
    });
  }

  async getInvocation(invocationId: string): Promise<InvocationRecord | null> {
    const row = asRow(this.database.prepare("SELECT * FROM invocations WHERE invocation_id = ?").get(invocationId));
    return row === undefined ? null : mapInvocation(row);
  }

  async linkWakeTurnInvocation(turnId: string, invocationId: string, now: string): Promise<void> {
    const result = this.database.prepare(`
      UPDATE wake_turns SET invocation_id = ?, last_activity_at = ? WHERE turn_id = ? AND invocation_id IS NULL`)
      .run(invocationId, now, turnId);
    if (result.changes === 0) {
      const row = asRow(this.database.prepare("SELECT invocation_id FROM wake_turns WHERE turn_id = ?").get(turnId));
      if (row === undefined) throw new DomainError("wake_turn_not_found", "Wake Turn was not found.");
      if (optionalTextValue(row, "invocation_id") !== invocationId) {
        throw new DomainError("wake_turn_invocation_conflict", "Wake Turn is already linked to another invocation.");
      }
    }
  }

  async getPrimaryAgentContext(input: { affairKey: string; agentConnectionId: string; lifeId: string }): Promise<PrimaryAgentContextRecord | null> {
    const row = asRow(this.database.prepare(`
      SELECT * FROM primary_agent_contexts WHERE life_id = ? AND affair_key = ? AND agent_connection_id = ?`)
      .get(input.lifeId, input.affairKey, input.agentConnectionId));
    return row === undefined ? null : {
      affairKey: textValue(row, "affair_key"),
      agentConnectionId: textValue(row, "agent_connection_id"),
      contextId: textValue(row, "context_id"),
      createdAt: textValue(row, "created_at"),
      lifeId: textValue(row, "life_id"),
      updatedAt: textValue(row, "updated_at"),
    };
  }

  async savePrimaryAgentContext(record: PrimaryAgentContextRecord): Promise<void> {
    this.database.prepare(`
      INSERT INTO primary_agent_contexts
        (life_id, affair_key, agent_connection_id, context_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(life_id, affair_key) DO UPDATE SET
        agent_connection_id = excluded.agent_connection_id,
        context_id = excluded.context_id,
        updated_at = excluded.updated_at`)
      .run(record.lifeId, record.affairKey, record.agentConnectionId, record.contextId, record.createdAt, record.updatedAt);
  }

  async clearPrimaryAgentContext(input: { affairKey: string; agentConnectionId: string; lifeId: string }): Promise<void> {
    this.database.prepare(`
      DELETE FROM primary_agent_contexts WHERE life_id = ? AND affair_key = ? AND agent_connection_id = ?`)
      .run(input.lifeId, input.affairKey, input.agentConnectionId);
  }

  async updateInvocation(invocationId: string, patch: {
    acceptedAt?: string;
    contextId?: string;
    sendAttempts?: number;
    status?: InvocationStatus;
    taskId?: string;
    updatedAt: string;
  }): Promise<InvocationRecord> {
    const existing = await this.getInvocation(invocationId);
    if (existing === null) throw new Error("Invocation was not found during update.");
    const next = { ...existing, ...patch };
    this.database.prepare(`
      UPDATE invocations
         SET task_id = ?, context_id = ?, status = ?, send_attempts = ?, accepted_at = ?,
             last_activity_at = ?, updated_at = ?
       WHERE invocation_id = ?`)
      .run(next.taskId ?? null, next.contextId ?? null, next.status, next.sendAttempts,
        next.acceptedAt ?? null, patch.updatedAt, patch.updatedAt, invocationId);
    const updated = await this.getInvocation(invocationId);
    if (updated === null) throw new Error("Invocation disappeared during update.");
    return updated;
  }

  async createInteraction(record: InteractionRecord): Promise<InteractionRecord> {
    this.database.prepare(`
      INSERT INTO interactions (interaction_id, invocation_id, kind, prompt, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(record.interactionId, record.invocationId, record.kind, record.prompt, record.status, record.createdAt);
    return record;
  }

  async getInteraction(interactionId: string): Promise<InteractionRecord | null> {
    const row = asRow(this.database.prepare("SELECT * FROM interactions WHERE interaction_id = ?").get(interactionId));
    return row === undefined ? null : mapInteraction(row);
  }

  async getInteractionScope(interactionId: string): Promise<{ affairId?: string; lifeId: string } | null> {
    const row = asRow(this.database.prepare(`
      SELECT COALESCE(d.life_id, w.life_id) AS life_id, d.affair_id
        FROM interactions i
        JOIN invocations v ON v.invocation_id = i.invocation_id
        LEFT JOIN delegations d ON d.invocation_id = v.invocation_id
        LEFT JOIN wake_turns wt ON wt.invocation_id = v.invocation_id
        LEFT JOIN wakes w ON w.wake_id = wt.wake_id
       WHERE i.interaction_id = ?`).get(interactionId));
    const lifeId = row === undefined ? undefined : optionalTextValue(row, "life_id");
    if (row === undefined || lifeId === undefined) return null;
    const affairId = optionalTextValue(row, "affair_id");
    return { lifeId, ...(affairId === undefined ? {} : { affairId }) };
  }

  async resolveInteraction(interactionId: string): Promise<InteractionRecord> {
    const result = this.database.prepare("UPDATE interactions SET status = 'RESOLVED' WHERE interaction_id = ? AND status = 'PENDING'").run(interactionId);
    if (result.changes === 0) throw new DomainError("interaction_stale", "Interaction is no longer pending.");
    const interaction = await this.getInteraction(interactionId);
    if (interaction === null) throw new Error("Interaction disappeared during resolution.");
    return interaction;
  }

  async listInvocationInteractions(invocationId: string): Promise<InteractionRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM interactions WHERE invocation_id = ? ORDER BY created_at, interaction_id")
      .all(invocationId)).map(mapInteraction);
  }

  async listPendingInteractions(): Promise<InteractionRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM interactions WHERE status = 'PENDING' ORDER BY created_at, interaction_id").all()).map(mapInteraction);
  }

  async createArtifact(record: ArtifactRecord): Promise<ArtifactRecord> {
    if (record.lifeId !== undefined) {
      const existing = asRow(this.database.prepare(`
        SELECT life_id, affair_id, size_bytes FROM artifacts WHERE invocation_id = ? AND remote_artifact_id = ?`)
        .get(record.invocationId, record.remoteArtifactId));
      const sameScope = existing !== undefined
        && optionalTextValue(existing, "life_id") === record.lifeId
        && optionalTextValue(existing, "affair_id") === record.affairId;
      const additionalBytes = sameScope ? Math.max(0, record.size - numberValue(existing, "size_bytes")) : record.size;
      await this.assertArtifactQuota({
        ...(record.affairId === undefined ? {} : { affairId: record.affairId }), additionalBytes, lifeId: record.lifeId,
      });
    }
    this.database.prepare(`
      INSERT INTO artifacts (artifact_id, invocation_id, remote_artifact_id, filename, mime_type, size_bytes, relative_path, sha256, created_at, life_id, affair_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(invocation_id, remote_artifact_id) DO UPDATE SET
        filename = excluded.filename, mime_type = excluded.mime_type, size_bytes = excluded.size_bytes,
        relative_path = excluded.relative_path, sha256 = excluded.sha256,
        life_id = excluded.life_id, affair_id = excluded.affair_id`)
      .run(record.artifactId, record.invocationId, record.remoteArtifactId, record.filename, record.mimeType,
        record.size, record.relativePath ?? null, record.sha256 ?? null, record.createdAt, record.lifeId ?? null, record.affairId ?? null);
    const row = asRow(this.database.prepare("SELECT * FROM artifacts WHERE invocation_id = ? AND remote_artifact_id = ?")
      .get(record.invocationId, record.remoteArtifactId));
    if (row === undefined) throw new Error("Artifact metadata could not be read after persistence.");
    return mapArtifact(row);
  }

  async assertArtifactQuota(input: { affairId?: string; additionalBytes: number; lifeId: string }): Promise<void> {
    const row = asRow(this.database.prepare(`
      SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM artifacts
       WHERE life_id = ? AND affair_id IS ?`).get(input.lifeId, input.affairId ?? null));
    const stored = row === undefined ? 0 : numberValue(row, "bytes");
    if (stored + input.additionalBytes > 500 * 1024 * 1024) {
      throw new DomainError("artifact_quota_exceeded", "Artifact storage for this Affair exceeds 500 MiB.");
    }
  }

  async getArtifact(artifactId: string): Promise<ArtifactRecord | null> {
    const row = asRow(this.database.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId));
    return row === undefined ? null : mapArtifact(row);
  }

  async listInvocationArtifacts(invocationId: string): Promise<ArtifactRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM artifacts WHERE invocation_id = ? ORDER BY created_at, artifact_id")
      .all(invocationId)).map(mapArtifact);
  }

  async listLifeArtifacts(lifeId: string): Promise<ArtifactRecord[]> {
    return asRows(this.database.prepare(`
      SELECT * FROM artifacts WHERE life_id = ? ORDER BY created_at, artifact_id`).all(lifeId)).map(mapArtifact);
  }

  async createLife(record: LifeCreateRecord, idempotencyKey?: string): Promise<LifeMutationResult> {
    return this.inTransaction(() => {
      if (idempotencyKey !== undefined) {
        const previous = asRow(this.database.prepare(`
          SELECT resource_id, event_sequence FROM idempotency_keys
           WHERE scope = 'life.create' AND idempotency_key = ?`).get(idempotencyKey));
        if (previous !== undefined) {
          const life = this.getLifeSync(textValue(previous, "resource_id"));
          const eventRow = asRow(this.database.prepare("SELECT * FROM sse_events WHERE sequence = ?").get(numberValue(previous, "event_sequence")));
          if (life === null || eventRow === undefined) throw new Error("Idempotency record points to missing data.");
          return { event: mapSseEvent(eventRow), life };
        }
      }

      const agent = asRow(this.database.prepare("SELECT status FROM agent_connections WHERE agent_connection_id = ?").get(record.mainAgentConnectionId));
      if (agent === undefined || textValue(agent, "status") !== "ACTIVE") {
        throw new DomainError("life_primary_agent_not_ready", "Primary Agent connection must be active before creating a Life.");
      }

      this.database.prepare(`
        INSERT INTO lives (life_id, name, avatar_url, role, initial_goal, timezone, state, main_agent_connection_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'STOPPED', ?, ?, ?)`)
        .run(record.lifeId, record.name, record.avatarUrl ?? null, record.role ?? null, record.initialGoal ?? null, record.timezone,
          record.mainAgentConnectionId, record.createdAt, record.createdAt);
      this.database.prepare(`
        INSERT INTO persona_versions (persona_version_id, life_id, summary, principles_json, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(record.personaVersionId, record.lifeId, record.personaSummary, JSON.stringify(record.principles), record.createdAt);
      this.database.prepare("UPDATE lives SET current_persona_version_id = ? WHERE life_id = ?")
        .run(record.personaVersionId, record.lifeId);
      const event = this.appendSseEventSync({
        entityId: record.lifeId,
        payload: { lifeId: record.lifeId, state: "STOPPED" },
        type: "life.created",
      }, record.createdAt);
      if (idempotencyKey !== undefined) {
        this.database.prepare(`
          INSERT INTO idempotency_keys (scope, idempotency_key, resource_id, event_sequence, created_at)
          VALUES ('life.create', ?, ?, ?, ?)`)
          .run(idempotencyKey, record.lifeId, event.sequence, record.createdAt);
      }
      const life = this.getLifeSync(record.lifeId);
      if (life === null) throw new Error("Created Life could not be read back.");
      return { event, life };
    });
  }

  async getLife(lifeId: string): Promise<Life | null> {
    return this.getLifeSync(lifeId);
  }

  async listLives(input: { after?: { createdAt: string; lifeId: string }; limit: number }): Promise<LifeListPage> {
    const limit = Math.max(1, Math.min(input.limit, 100));
    const rows = input.after === undefined
      ? asRows(this.database.prepare(`${LIFE_SELECT} ORDER BY l.created_at DESC, l.life_id DESC LIMIT ?`).all(limit + 1))
      : asRows(this.database.prepare(`${LIFE_SELECT}
          WHERE l.created_at < ? OR (l.created_at = ? AND l.life_id < ?)
          ORDER BY l.created_at DESC, l.life_id DESC LIMIT ?`)
        .all(input.after.createdAt, input.after.createdAt, input.after.lifeId, limit + 1));
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapLife);
    const last = items.at(-1);
    return {
      items,
      ...(hasMore && last !== undefined ? { next: { createdAt: last.createdAt, lifeId: last.lifeId } } : {}),
    };
  }

  async updateLife(input: { lifeId: string; now: string; patch: UpdateLifeInput; personaVersionId: string }): Promise<LifeMutationResult | null> {
    return this.inTransaction(() => {
      const existing = this.getLifeSync(input.lifeId);
      if (existing === null) return null;
      const next = { ...existing, ...input.patch };
      this.database.prepare(`
        INSERT INTO persona_versions (persona_version_id, life_id, summary, principles_json, created_at)
        VALUES (?, ?, ?, ?, ?)`)
        .run(input.personaVersionId, input.lifeId, next.personaSummary, JSON.stringify(next.principles), input.now);
      this.database.prepare(`
        UPDATE lives
           SET name = ?, avatar_url = ?, role = ?, initial_goal = ?, timezone = ?, current_persona_version_id = ?, updated_at = ?
         WHERE life_id = ?`)
        .run(next.name, next.avatarUrl ?? null, next.role ?? null, next.initialGoal ?? null, next.timezone, input.personaVersionId, input.now, input.lifeId);
      const event = this.appendSseEventSync({
        entityId: input.lifeId,
        payload: { lifeId: input.lifeId },
        type: "life.updated",
      }, input.now);
      const life = this.getLifeSync(input.lifeId);
      if (life === null) throw new Error("Updated Life could not be read back.");
      return { event, life };
    });
  }

  async updateLifeRhythm(input: {
    autonomousWakesDefault: number;
    idleExplorationsDefault: number;
    invocationsDefault: number;
    lifeId: string;
    now: string;
    quietEnd: string;
    quietStart: string;
  }): Promise<LifeMutationResult | null> {
    return this.inTransaction(() => {
      if (this.getLifeSync(input.lifeId) === null) return null;
      this.database.prepare(`
        UPDATE lives SET quiet_start = ?, quiet_end = ?, autonomous_wakes_default = ?,
          invocations_default = ?, idle_explorations_default = ?, updated_at = ? WHERE life_id = ?`)
        .run(input.quietStart, input.quietEnd, input.autonomousWakesDefault, input.invocationsDefault,
          input.idleExplorationsDefault, input.now, input.lifeId);
      const event = this.appendSseEventSync({
        entityId: input.lifeId,
        payload: { lifeId: input.lifeId },
        type: "life.rhythm.updated",
      }, input.now);
      const life = this.getLifeSync(input.lifeId);
      if (life === null) throw new Error("Life disappeared during rhythm update.");
      return { event, life };
    });
  }

  async deleteLife(lifeId: string, now: string): Promise<SseEvent | null> {
    return this.inTransaction(() => {
      const existing = this.getLifeSync(lifeId);
      if (existing === null) return null;
      this.database.prepare("DELETE FROM lives WHERE life_id = ?").run(lifeId);
      return this.appendSseEventSync({ entityId: lifeId, payload: { lifeId }, type: "life.deleted" }, now);
    });
  }

  async archiveLife(lifeId: string, now: string): Promise<LifeMutationResult | null> {
    return this.inTransaction(() => {
      const existing = this.getLifeSync(lifeId);
      if (existing === null) return null;
      const wake = this.getActiveWakeSync(lifeId);
      if (wake !== null) {
        this.database.prepare(`
          UPDATE life_events SET status = 'PENDING', claimed_by_wake_id = NULL, last_error_code = 'life_archived'
           WHERE claimed_by_wake_id = ? AND status = 'CLAIMED'`).run(wake.wakeId);
        this.database.prepare(`
          UPDATE wake_turns SET status = 'CANCELED', ended_at = ?, last_activity_at = ?
           WHERE wake_id = ? AND status = 'RUNNING'`).run(now, now, wake.wakeId);
        this.database.prepare(`
          UPDATE wakes SET status = 'CANCELED', failure_code = 'life_archived', ended_at = ?, updated_at = ?
           WHERE wake_id = ?`).run(now, now, wake.wakeId);
        this.database.prepare("DELETE FROM runtime_leases WHERE resource_type = 'life' AND resource_id = ?").run(lifeId);
      }
      this.database.prepare("UPDATE schedules SET enabled = 0, updated_at = ? WHERE life_id = ?").run(now, lifeId);
      this.database.prepare("UPDATE alarms SET status = 'CANCELED', updated_at = ? WHERE life_id = ? AND status = 'SCHEDULED'").run(now, lifeId);
      this.database.prepare("UPDATE lives SET state = 'STOPPED', archived_at = ?, updated_at = ? WHERE life_id = ?").run(now, now, lifeId);
      const event = this.appendSseEventSync({
        entityId: lifeId,
        payload: { archivedAt: now, lifeId, state: "STOPPED" },
        type: "life.archived",
      }, now);
      const life = this.getLifeSync(lifeId);
      if (life === null) throw new Error("Archived Life disappeared.");
      return { event, life };
    });
  }

  async getLifeDeletionImpact(lifeId: string): Promise<LifeDeletionImpact | null> {
    if (this.getLifeSync(lifeId) === null) return null;
    const count = (table: string) => {
      const row = asRow(this.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE life_id = ?`).get(lifeId));
      return row === undefined ? 0 : numberValue(row, "count");
    };
    return {
      affairs: count("affairs"),
      alarms: count("alarms"),
      artifacts: count("artifacts"),
      attachments: count("user_attachments"),
      delegations: count("delegations"),
      events: count("life_events"),
      managedBytes: ["artifacts", "user_attachments"].reduce((total, table) => {
        const row = asRow(this.database.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM ${table} WHERE life_id = ?`).get(lifeId));
        return total + (row === undefined ? 0 : numberValue(row, "bytes"));
      }, 0),
      memories: count("memory_fragments"),
      schedules: count("schedules"),
      todos: count("todos"),
      wakes: count("wakes"),
    };
  }

  async getLifeOverviewFacts(input: { lifeId: string; localDate: string; now: string }): Promise<LifeOverviewFacts> {
    await this.getDailyBudget(input.lifeId, input.localDate, input.now);
    const budget = await this.getDailyBudget(input.lifeId, input.localDate, input.now);
    const pending = asRow(this.database.prepare(`
      SELECT COUNT(*) AS count FROM life_events WHERE life_id = ? AND status = 'PENDING'`).get(input.lifeId));
    const alarm = asRow(this.database.prepare(`
      SELECT MIN(next_at) AS next_at FROM alarms WHERE life_id = ? AND status = 'SCHEDULED' AND next_at > ?`)
      .get(input.lifeId, input.now));
    const schedules = asRows(this.database.prepare(`
      SELECT local_time, timezone FROM schedules WHERE life_id = ? AND enabled = 1 ORDER BY schedule_id`).all(input.lifeId))
      .map((row) => ({ localTime: textValue(row, "local_time"), timezone: textValue(row, "timezone") }));
    const nextAlarmAt = alarm === undefined ? undefined : optionalTextValue(alarm, "next_at");
    return {
      autonomousBudgetDailyLimit: budget.autonomousWakesLimit,
      autonomousBudgetUsed: budget.autonomousWakesUsed,
      pendingEventCount: pending === undefined ? 0 : numberValue(pending, "count"),
      schedules,
      totalBudgetDailyLimit: budget.invocationsLimit,
      totalBudgetUsed: budget.invocationsUsed,
      ...(nextAlarmAt === undefined ? {} : { nextAlarmAt }),
    };
  }

  async getLifeHandoffContext(lifeId: string): Promise<LifeHandoffContext | null> {
    if (this.getLifeSync(lifeId) === null) return null;
    const affairs = asRows(this.database.prepare(`
      SELECT title, status, summary FROM affairs WHERE life_id = ? AND status NOT IN ('DONE', 'CANCELED')
       ORDER BY updated_at DESC, affair_id LIMIT 20`).all(lifeId)).map((row) => {
      const summary = optionalTextValue(row, "summary");
      return { status: textValue(row, "status"), title: textValue(row, "title"), ...(summary === undefined ? {} : { summary }) };
    });
    const todos = asRows(this.database.prepare(`
      SELECT title, status FROM todos WHERE life_id = ? AND status NOT IN ('DONE', 'CANCELED')
       ORDER BY due_at IS NULL, due_at, todo_id LIMIT 30`).all(lifeId))
      .map((row) => ({ status: textValue(row, "status"), title: textValue(row, "title") }));
    const cards = asRows(this.database.prepare(`
      SELECT content FROM memory_fragments WHERE life_id = ? AND kind = 'CARD' AND status = 'ACTIVE'
       ORDER BY confidence DESC, updated_at DESC, memory_id LIMIT 20`).all(lifeId)).map((row) => textValue(row, "content"));
    const residueRow = asRow(this.database.prepare("SELECT text FROM consciousness_residue WHERE life_id = ?").get(lifeId));
    const residue = residueRow === undefined ? undefined : textValue(residueRow, "text");
    return { affairs, cards, todos, ...(residue === undefined ? {} : { residue }) };
  }

  async changePrimaryAgent(input: {
    fromAgentConnectionId: string;
    handoffId: string;
    lifeId: string;
    now: string;
    summary: string;
    toAgentConnectionId: string;
  }): Promise<{ event: SseEvent; handoff: PrimaryAgentHandoff; life: Life }> {
    return this.inTransaction(() => {
      const life = this.getLifeSync(input.lifeId);
      if (life === null) throw new DomainError("life_not_found", "Life was not found.");
      if (life.state !== "PAUSED" || life.mainAgentConnectionId !== input.fromAgentConnectionId) {
        throw new DomainError("life_primary_agent_change_requires_pause", "Pause the Life before changing its primary Agent.");
      }
      const agent = asRow(this.database.prepare("SELECT status FROM agent_connections WHERE agent_connection_id = ?")
        .get(input.toAgentConnectionId));
      if (agent === undefined) throw new DomainError("agent_not_found", "Agent connection was not found.");
      if (textValue(agent, "status") !== "ACTIVE") {
        throw new DomainError("life_primary_agent_not_ready", "The new primary Agent must pass joi readiness.");
      }
      this.database.prepare("DELETE FROM life_agent_bindings WHERE life_id = ? AND role = 'PRIMARY'").run(input.lifeId);
      this.database.prepare(`
        INSERT INTO life_agent_bindings (life_id, agent_connection_id, role, created_at)
        VALUES (?, ?, 'PRIMARY', ?)
        ON CONFLICT(life_id, agent_connection_id) DO UPDATE SET role = 'PRIMARY'`)
        .run(input.lifeId, input.toAgentConnectionId, input.now);
      this.database.prepare("UPDATE lives SET main_agent_connection_id = ?, updated_at = ? WHERE life_id = ?")
        .run(input.toAgentConnectionId, input.now, input.lifeId);
      this.database.prepare("DELETE FROM primary_agent_contexts WHERE life_id = ?").run(input.lifeId);
      this.database.prepare(`
        INSERT INTO primary_agent_handoffs
          (handoff_id, life_id, from_agent_connection_id, to_agent_connection_id, summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(input.handoffId, input.lifeId, input.fromAgentConnectionId, input.toAgentConnectionId, input.summary, input.now);
      const event = this.appendSseEventSync({
        entityId: input.lifeId,
        payload: { fromAgentConnectionId: input.fromAgentConnectionId, lifeId: input.lifeId, toAgentConnectionId: input.toAgentConnectionId },
        type: "life.primary_agent.changed",
      }, input.now);
      const updated = this.getLifeSync(input.lifeId);
      if (updated === null) throw new Error("Life disappeared during primary Agent change.");
      return {
        event,
        handoff: {
          createdAt: input.now,
          fromAgentConnectionId: input.fromAgentConnectionId,
          handoffId: input.handoffId,
          lifeId: input.lifeId,
          summary: input.summary,
          toAgentConnectionId: input.toAgentConnectionId,
        },
        life: updated,
      };
    });
  }

  async listPrimaryAgentHandoffs(lifeId: string): Promise<PrimaryAgentHandoff[]> {
    return asRows(this.database.prepare(`
      SELECT * FROM primary_agent_handoffs WHERE life_id = ? ORDER BY created_at, handoff_id`).all(lifeId))
      .map(mapPrimaryAgentHandoff);
  }

  async appendSseEvent(input: Omit<SseEvent, "createdAt" | "sequence">): Promise<SseEvent> {
    return this.appendSseEventSync(input, new Date().toISOString());
  }

  async listSseEvents(afterSequence: number, limit: number): Promise<SseEvent[]> {
    return asRows(this.database.prepare(`
      SELECT sequence, event_type, entity_id, payload_json, created_at
        FROM sse_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`)
      .all(afterSequence, Math.max(1, Math.min(limit, 1000)))).map(mapSseEvent);
  }

  async getSseSequenceWindow(): Promise<SseSequenceWindow> {
    const retained = asRow(this.database.prepare("SELECT MIN(sequence) AS earliest, MAX(sequence) AS latest FROM sse_events").get());
    const issued = asRow(this.database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sse_events'").get());
    const earliest = retained === undefined ? undefined : optionalNumberValue(retained, "earliest");
    const retainedLatest = retained === undefined ? undefined : optionalNumberValue(retained, "latest");
    const latestIssuedSequence = issued === undefined ? (retainedLatest ?? 0) : numberValue(issued, "seq");
    return { latestIssuedSequence, ...(earliest === undefined ? {} : { earliestRetainedSequence: earliest }) };
  }

  async pruneSseEventsBefore(cutoff: string): Promise<number> {
    return Number(this.database.prepare("DELETE FROM sse_events WHERE created_at < ?").run(cutoff).changes);
  }

  async enqueueOutbox(input: OutboxInput): Promise<void> {
    this.database.prepare(`
      INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at)
      VALUES (?, ?, ?, 'PENDING', 0, ?, ?)`)
      .run(input.outboxId, input.kind, JSON.stringify(input.payload), input.availableAt, new Date().toISOString());
  }

  async countOutbox(): Promise<number> {
    const row = asRow(this.database.prepare("SELECT COUNT(*) AS count FROM outbox").get());
    return row === undefined ? 0 : numberValue(row, "count");
  }

  async claimOutbox(input: { claimUntil: string; excludeKinds?: string[]; limit: number; now: string; owner: string }): Promise<OutboxRecord[]> {
    const excluded = input.excludeKinds ?? [];
    const kindFilter = excluded.length > 0 ? ` AND kind NOT IN (${excluded.map(() => "?").join(", ")})` : "";
    return this.inTransaction(() => {
      const candidates = asRows(this.database.prepare(`
        SELECT outbox_id FROM outbox
         WHERE available_at <= ?
           AND (status = 'PENDING' OR (status = 'CLAIMED' AND claim_until <= ?))${kindFilter}
         ORDER BY created_at ASC, outbox_id ASC LIMIT ?`)
        .all(input.now, input.now, ...excluded, Math.max(1, Math.min(input.limit, 100))));
      const output: OutboxRecord[] = [];
      for (const candidate of candidates) {
        const outboxId = textValue(candidate, "outbox_id");
        this.database.prepare(`
          UPDATE outbox SET status = 'CLAIMED', claim_owner = ?, claim_until = ?, attempt_count = attempt_count + 1
           WHERE outbox_id = ?`).run(input.owner, input.claimUntil, outboxId);
        const row = asRow(this.database.prepare("SELECT * FROM outbox WHERE outbox_id = ?").get(outboxId));
        if (row !== undefined) output.push(mapOutbox(row));
      }
      return output;
    });
  }

  async claimOutboxById(input: { claimUntil: string; now: string; outboxId: string; owner: string }): Promise<OutboxRecord | null> {
    return this.inTransaction(() => {
      const result = this.database.prepare(`
        UPDATE outbox
           SET status = 'CLAIMED', claim_owner = ?, claim_until = ?, attempt_count = attempt_count + 1
         WHERE outbox_id = ? AND available_at <= ?
           AND (status = 'PENDING' OR (status = 'CLAIMED' AND claim_until <= ?))`)
        .run(input.owner, input.claimUntil, input.outboxId, input.now, input.now);
      if (result.changes === 0) return null;
      const row = asRow(this.database.prepare("SELECT * FROM outbox WHERE outbox_id = ?").get(input.outboxId));
      return row === undefined ? null : mapOutbox(row);
    });
  }

  async completeOutbox(outboxId: string, owner: string): Promise<void> {
    const result = this.database.prepare(`
      UPDATE outbox SET status = 'DONE', claim_owner = NULL, claim_until = NULL
       WHERE outbox_id = ? AND status = 'CLAIMED' AND claim_owner = ?`).run(outboxId, owner);
    if (result.changes === 0) throw new DomainError("outbox_claim_lost", "Outbox claim is no longer owned by this dispatcher.");
  }

  async releaseOutbox(input: { availableAt: string; outboxId: string; owner: string }): Promise<void> {
    const result = this.database.prepare(`
      UPDATE outbox SET status = 'PENDING', available_at = ?, claim_owner = NULL, claim_until = NULL
       WHERE outbox_id = ? AND status = 'CLAIMED' AND claim_owner = ?`)
      .run(input.availableAt, input.outboxId, input.owner);
    if (result.changes === 0) throw new DomainError("outbox_claim_lost", "Outbox claim is no longer owned by this dispatcher.");
  }

  async acquireLease(input: Omit<RuntimeLease, "generation"> & { now: string }): Promise<RuntimeLease | null> {
    return this.inTransaction(() => {
      const row = asRow(this.database.prepare(`
        SELECT owner, generation, expires_at FROM runtime_leases
         WHERE resource_type = ? AND resource_id = ?`).get(input.resourceType, input.resourceId));
      if (row === undefined) {
        this.database.prepare(`
          INSERT INTO runtime_leases (resource_type, resource_id, owner, generation, expires_at)
          VALUES (?, ?, ?, 1, ?)`)
          .run(input.resourceType, input.resourceId, input.owner, input.expiresAt);
        return { expiresAt: input.expiresAt, generation: 1, owner: input.owner, resourceId: input.resourceId, resourceType: input.resourceType };
      }
      const currentOwner = textValue(row, "owner");
      const expired = textValue(row, "expires_at") <= input.now;
      if (!expired && currentOwner !== input.owner) return null;
      const generation = numberValue(row, "generation") + (expired && currentOwner !== input.owner ? 1 : 0);
      this.database.prepare(`
        UPDATE runtime_leases SET owner = ?, generation = ?, expires_at = ?
         WHERE resource_type = ? AND resource_id = ?`)
        .run(input.owner, generation, input.expiresAt, input.resourceType, input.resourceId);
      return { expiresAt: input.expiresAt, generation, owner: input.owner, resourceId: input.resourceId, resourceType: input.resourceType };
    });
  }

  async getAdminCredential(): Promise<AdminCredentialRecord | null> {
    const row = asRow(this.database.prepare("SELECT * FROM admin_credentials WHERE singleton_id = 1").get());
    if (row === undefined) return null;
    return {
      algorithm: "scrypt",
      derivedKey: textValue(row, "derived_key"),
      parameters: {
        blockSize: numberValue(row, "block_size"),
        cost: numberValue(row, "cost"),
        keyLength: numberValue(row, "key_length"),
        parallelization: numberValue(row, "parallelization"),
      },
      salt: textValue(row, "salt"),
      updatedAt: textValue(row, "updated_at"),
    };
  }

  async saveAdminCredential(record: AdminCredentialRecord): Promise<void> {
    this.inTransaction(() => {
      this.database.prepare(`
        INSERT INTO admin_credentials
          (singleton_id, algorithm, salt, derived_key, cost, block_size, parallelization, key_length, updated_at)
        VALUES (1, 'scrypt', ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          salt = excluded.salt, derived_key = excluded.derived_key, cost = excluded.cost,
          block_size = excluded.block_size, parallelization = excluded.parallelization,
          key_length = excluded.key_length, updated_at = excluded.updated_at`)
        .run(record.salt, record.derivedKey, record.parameters.cost, record.parameters.blockSize,
          record.parameters.parallelization, record.parameters.keyLength, record.updatedAt);
      this.database.prepare("UPDATE web_sessions SET revoked_at = ? WHERE kind = 'lan' AND revoked_at IS NULL").run(record.updatedAt);
    });
  }

  async saveSession(record: WebSessionRecord): Promise<void> {
    this.database.prepare(`
      INSERT INTO web_sessions
        (session_hash, csrf_hash, ip_hash, kind, created_at, last_activity_at, idle_expires_at, absolute_expires_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.sessionHash, record.csrfHash, record.ipHash, record.kind, record.createdAt,
        record.lastActivityAt, record.idleExpiresAt, record.absoluteExpiresAt, record.revokedAt ?? null);
  }

  async getSession(sessionHash: string): Promise<WebSessionRecord | null> {
    const row = asRow(this.database.prepare("SELECT * FROM web_sessions WHERE session_hash = ?").get(sessionHash));
    if (row === undefined) return null;
    const record: WebSessionRecord = {
      absoluteExpiresAt: textValue(row, "absolute_expires_at"),
      createdAt: textValue(row, "created_at"),
      csrfHash: textValue(row, "csrf_hash"),
      idleExpiresAt: textValue(row, "idle_expires_at"),
      ipHash: textValue(row, "ip_hash"),
      kind: textValue(row, "kind") as WebSessionRecord["kind"],
      lastActivityAt: textValue(row, "last_activity_at"),
      sessionHash: textValue(row, "session_hash"),
    };
    const revokedAt = optionalTextValue(row, "revoked_at");
    return { ...record, ...(revokedAt === undefined ? {} : { revokedAt }) };
  }

  async listSessions(): Promise<WebSessionRecord[]> {
    return asRows(this.database.prepare("SELECT * FROM web_sessions WHERE revoked_at IS NULL ORDER BY last_activity_at DESC").all())
      .map((row) => ({
        absoluteExpiresAt: textValue(row, "absolute_expires_at"),
        createdAt: textValue(row, "created_at"),
        csrfHash: textValue(row, "csrf_hash"),
        idleExpiresAt: textValue(row, "idle_expires_at"),
        ipHash: textValue(row, "ip_hash"),
        kind: textValue(row, "kind") as WebSessionRecord["kind"],
        lastActivityAt: textValue(row, "last_activity_at"),
        sessionHash: textValue(row, "session_hash"),
      }));
  }

  async touchSession(sessionHash: string, lastActivityAt: string, idleExpiresAt: string): Promise<void> {
    this.database.prepare("UPDATE web_sessions SET last_activity_at = ?, idle_expires_at = ? WHERE session_hash = ?")
      .run(lastActivityAt, idleExpiresAt, sessionHash);
  }

  async revokeSession(sessionHash: string, now: string): Promise<void> {
    this.database.prepare("UPDATE web_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL").run(now, sessionHash);
  }

  async revokeAllLanSessions(now: string): Promise<void> {
    this.database.prepare("UPDATE web_sessions SET revoked_at = ? WHERE kind = 'lan' AND revoked_at IS NULL").run(now);
  }

  async revokeAllSessions(now: string): Promise<void> {
    this.database.prepare("UPDATE web_sessions SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
  }

  async deleteExpiredSessions(now: string): Promise<void> {
    this.database.prepare("DELETE FROM web_sessions WHERE idle_expires_at <= ? OR absolute_expires_at <= ?").run(now, now);
  }

  createManifestHash(payload: Record<string, unknown>): string {
    return createHash("sha256").update(canonicalJson(payload)).digest("hex");
  }

  async getRuntimeStats(): Promise<RuntimeStats> {
    const count = (table: string, where = "") => {
      const row = asRow(this.database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get());
      return row === undefined ? 0 : numberValue(row, "count");
    };
    const journal = asRow(this.database.prepare("PRAGMA journal_mode").get());
    const integrity = asRow(this.database.prepare("PRAGMA quick_check").get());
    const schema = asRow(this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get());
    return {
      activeInvocations: count("invocations", "WHERE status NOT IN ('CANCELED', 'COMPLETED', 'FAILED', 'UNKNOWN_REQUIRES_REVIEW')"),
      activeWakes: count("wakes", "WHERE status IN ('CREATED', 'RUNNING')"),
      agentConnections: count("agent_connections", "WHERE deleted_at IS NULL"),
      backupHistory: count("backup_history"),
      enabledSchedules: count("schedules", "WHERE enabled = 1"),
      integrity: integrity === undefined ? "unknown" : textValue(integrity, "quick_check"),
      journalMode: journal === undefined ? "unknown" : textValue(journal, "journal_mode"),
      lives: count("lives"),
      openBreakers: count("connection_breakers"),
      pendingOutbox: count("outbox", "WHERE status = 'PENDING'"),
      runtimeLeases: count("runtime_leases"),
      scheduledAlarms: count("alarms", "WHERE status = 'SCHEDULED'"),
      schemaVersion: schema === undefined ? 0 : numberValue(schema, "version"),
      sessions: count("web_sessions", "WHERE revoked_at IS NULL"),
      sseEvents: count("sse_events"),
      staleWakeTurns: count("wake_turns", `WHERE status = 'RUNNING' AND last_activity_at < '${new Date(Date.now() - 5 * 60_000).toISOString()}'`),
    };
  }

  private getLifeSync(lifeId: string): Life | null {
    const row = asRow(this.database.prepare(`${LIFE_SELECT} WHERE l.life_id = ?`).get(lifeId));
    return row === undefined ? null : mapLife(row);
  }

  private attachmentsForMessageSync(lifeId: string, attachmentIds: string[]): UserAttachmentRecord[] {
    if (attachmentIds.length === 0) return [];
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length !== attachmentIds.length || uniqueIds.length > 8) {
      throw new DomainError("attachment_count_exceeded", "A message can contain at most 8 unique attachments.");
    }
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const attachments = asRows(this.database.prepare(`
      SELECT * FROM user_attachments WHERE attachment_id IN (${placeholders})`).all(...uniqueIds)).map(mapUserAttachment);
    if (attachments.length !== uniqueIds.length || attachments.some((attachment) => attachment.lifeId !== lifeId)) {
      throw new DomainError("attachment_not_found", "A message attachment was not found for this Life.");
    }
    if (attachments.some((attachment) => attachment.eventId !== undefined)) {
      throw new DomainError("attachment_already_used", "A message attachment was already assigned to another event.");
    }
    if (attachments.some((attachment) => attachment.size > 10 * 1024 * 1024)
      || attachments.reduce((total, attachment) => total + attachment.size, 0) > 25 * 1024 * 1024) {
      throw new DomainError("attachment_size_exceeded", "Message attachments exceed the 10 MiB per-file or 25 MiB total limit.");
    }
    const byId = new Map(attachments.map((attachment) => [attachment.attachmentId, attachment]));
    return uniqueIds.map((attachmentId) => {
      const attachment = byId.get(attachmentId);
      if (attachment === undefined) throw new Error("Attachment ordering failed.");
      return attachment;
    });
  }

  private insertLifeEventSync(record: CreateLifeEventRecord): void {
    this.database.prepare(`
      INSERT INTO life_events
        (event_id, life_id, event_type, source, priority, occurred_at, available_at, dedupe_key,
         affair_id, payload_json, attempt_count, claimed_by_wake_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.eventId, record.lifeId, record.type, record.source, record.priority, record.occurredAt,
        record.availableAt, record.dedupeKey ?? null, record.affairId ?? null, JSON.stringify(record.payload),
        record.attemptCount, record.claimedByWakeId ?? null, record.status, record.createdAt);
  }

  private getLifeEventSync(eventId: string): LifeEvent | null {
    const row = asRow(this.database.prepare("SELECT * FROM life_events WHERE event_id = ?").get(eventId));
    return row === undefined ? null : mapLifeEvent(row);
  }

  private getActiveWakeSync(lifeId: string): WakeRecord | null {
    const row = asRow(this.database.prepare(`
      SELECT * FROM wakes WHERE life_id = ? AND status IN ('CREATED', 'RUNNING')`).get(lifeId));
    return row === undefined ? null : mapWake(row);
  }

  private insertFlowEventSync(
    wakeId: string,
    eventType: string,
    entityId: string,
    metadata: Record<string, unknown>,
    createdAt: string,
  ): void {
    const sequenceRow = asRow(this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM flow_events WHERE wake_id = ?`).get(wakeId));
    const sequence = sequenceRow === undefined ? 1 : numberValue(sequenceRow, "next");
    this.database.prepare(`
      INSERT INTO flow_events
        (flow_event_id, wake_id, sequence, event_type, entity_id, correlation_id, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`flow_${wakeId}_${String(sequence)}`, wakeId, sequence, eventType, entityId, wakeId,
        JSON.stringify(metadata), createdAt);
  }

  private listExpressionsForWakeSync(wakeId: string): ExpressionRecord[] {
    return asRows(this.database.prepare("SELECT * FROM expressions WHERE wake_id = ? ORDER BY created_at, expression_id").all(wakeId)).map(mapExpression);
  }

  private agentUsage(agentConnectionId: string): Pick<PublicAgentConnection, "lifeBindings" | "recentInvocationStatus"> {
    const lifeBindings = asRows(this.database.prepare(`
      SELECT l.life_id, l.name, b.role
        FROM life_agent_bindings b JOIN lives l ON l.life_id = b.life_id
       WHERE b.agent_connection_id = ? ORDER BY l.name, l.life_id`).all(agentConnectionId)).map((row) => ({
      lifeId: textValue(row, "life_id"), name: textValue(row, "name"), role: textValue(row, "role") as "COLLABORATOR" | "PRIMARY",
    }));
    const invocation = asRow(this.database.prepare(`
      SELECT status FROM invocations WHERE agent_connection_id = ? ORDER BY updated_at DESC, invocation_id DESC LIMIT 1`).get(agentConnectionId));
    return {
      ...(lifeBindings.length === 0 ? {} : { lifeBindings }),
      ...(invocation === undefined ? {} : { recentInvocationStatus: textValue(invocation, "status") }),
    };
  }

  private getAgentIntegrationRecordSync(agentConnectionId: string): AgentIntegrationRecord | null {
    const row = asRow(this.database.prepare(`
      SELECT a.agent_connection_id, a.status, a.token_required, a.readiness, a.credential_id, a.credential_version,
             c.encrypted_blob, s.*
        FROM agent_connections a
        JOIN agent_credentials c ON c.credential_id = a.credential_id
        JOIN agent_card_snapshots s ON s.card_snapshot_id = a.card_snapshot_id
       WHERE a.agent_connection_id = ? AND a.deleted_at IS NULL`).get(agentConnectionId));
    if (row === undefined) return null;
    const blob = row.encrypted_blob;
    if (!(blob instanceof Uint8Array)) throw new Error("Encrypted Agent credential has an invalid storage type.");
    return {
      agentConnectionId: textValue(row, "agent_connection_id"),
      card: mapCard(row),
      credentialId: textValue(row, "credential_id"),
      credentialVersion: numberValue(row, "credential_version"),
      encryptedCredential: blob,
      readiness: numberValue(row, "readiness") === 1,
      status: agentStatus(row),
    };
  }

  private insertCardSnapshot(agentConnectionId: string, cardSnapshotId: string, card: AgentCardCandidate, now: string): void {
    this.database.prepare(`
      INSERT INTO agent_card_snapshots
        (card_snapshot_id, agent_connection_id, card_url, card_url_hash, card_hash, name, description,
         rpc_url, origin, protocol_version, transport, authentication, streaming, skills_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cardSnapshotId, agentConnectionId, card.cardUrl, card.cardUrlHash, card.cardHash, card.name,
        card.description, card.rpcUrl, card.origin, card.protocolVersion, card.transport, card.authentication,
        card.capabilities.streaming ? 1 : 0, JSON.stringify(card.skills), now);
  }

  private upsertAgentConnection(input: SaveOnboardedAgentInput, createdAt: string): void {
    this.database.prepare(`
      INSERT INTO agent_connections
        (agent_connection_id, name, card_url, status, created_at, updated_at, description, skills_json,
         readiness, card_url_hash, credential_id, credential_version, origin_hash, last_validated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_connection_id) DO UPDATE SET
        name = excluded.name, card_url = excluded.card_url, status = excluded.status,
        updated_at = excluded.updated_at, description = excluded.description, skills_json = excluded.skills_json,
        readiness = excluded.readiness, card_url_hash = excluded.card_url_hash,
        credential_id = excluded.credential_id, credential_version = excluded.credential_version,
        origin_hash = excluded.origin_hash, last_validated_at = excluded.last_validated_at,
        token_required = 0`)
      .run(input.agentConnectionId, input.card.name, input.card.cardUrl, input.status, createdAt, input.now,
        input.card.description, JSON.stringify(input.card.skills), input.readiness ? 1 : 0, input.card.cardUrlHash,
        input.credentialId, input.credentialVersion, this.createManifestHash({ origin: input.card.origin }), input.now);
  }

  /** SSE transport retired (ADR 0009): the projection is frozen; a synthetic event keeps port callers working. */
  private appendSseEventSync(input: Omit<SseEvent, "createdAt" | "sequence">, createdAt: string): SseEvent {
    return { ...input, createdAt, sequence: 0 };
  }

  private persistMemoryEntities(memoryId: string, lifeId: string, action: Record<string, unknown>, now: string): void {
    if (!Array.isArray(action.entities)) return;
    for (const item of action.entities) {
      if (item === null || Array.isArray(item) || typeof item !== "object") continue;
      const entity = item as Record<string, unknown>;
      if (typeof entity.name !== "string" || typeof entity.type !== "string" || typeof entity.relation !== "string") continue;
      const name = entity.name.normalize("NFKC").trim();
      const type = entity.type.normalize("NFKC").trim();
      const relation = entity.relation.normalize("NFKC").trim();
      const normalized = name.toLocaleLowerCase();
      const entityId = `entity_${this.createManifestHash({ lifeId, normalized, type }).slice(0, 32)}`;
      this.database.prepare(`
        INSERT INTO memory_entities (entity_id, life_id, canonical_name, normalized_name, entity_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(life_id, normalized_name, entity_type) DO UPDATE SET
          canonical_name = excluded.canonical_name, updated_at = excluded.updated_at`)
        .run(entityId, lifeId, name, normalized, type, now, now);
      const stored = asRow(this.database.prepare(`
        SELECT entity_id FROM memory_entities WHERE life_id = ? AND normalized_name = ? AND entity_type = ?`)
        .get(lifeId, normalized, type));
      if (stored === undefined) throw new Error("Memory entity disappeared during persistence.");
      const storedId = textValue(stored, "entity_id");
      const linkId = `memory_link_${this.createManifestHash({ memoryId, relation, storedId }).slice(0, 32)}`;
      this.database.prepare(`
        INSERT OR IGNORE INTO memory_entity_links (link_id, life_id, memory_id, entity_id, relation, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(linkId, lifeId, memoryId, storedId, relation, now);
    }
  }

  private withMemoryEntities(memories: MemoryRecord[]): MemoryRecord[] {
    const query = this.database.prepare(`
      SELECT e.canonical_name, e.entity_type, l.relation
        FROM memory_entity_links l JOIN memory_entities e ON e.entity_id = l.entity_id
       WHERE l.memory_id = ? ORDER BY e.canonical_name, l.relation`);
    return memories.map((memory) => {
      const entities = asRows(query.all(memory.memoryId)).map((row) => ({
        name: textValue(row, "canonical_name"), relation: textValue(row, "relation"), type: textValue(row, "entity_type"),
      }));
      return { ...memory, ...(entities.length === 0 ? {} : { entities }) };
    });
  }

  private inTransaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function memoryQueryTokens(query: string): string[] {
  const tokens: string[] = [];
  const append = (token: string) => {
    if (token.length > 0 && !tokens.includes(token) && tokens.length < 12) tokens.push(token);
  };
  for (const match of query.matchAll(/[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    append(token);
    if (/\p{Script=Han}/u.test(token) && token.length > 2) {
      const characters = Array.from(token);
      for (let index = 0; index < characters.length - 1 && tokens.length < 12; index += 1) {
        append(`${characters[index] ?? ""}${characters[index + 1] ?? ""}`);
      }
    }
    if (tokens.length >= 12) break;
  }
  return tokens;
}

export interface RuntimeDatabase {
  backupTo(destinationPath: string): Promise<number>;
  close(): void;
  inspect(): { busyTimeout: number; foreignKeys: boolean; journalMode: string; migrationFailure?: "migration_failed"; mode: "read-only-recovery" | "read-write"; queryOnly: boolean; schemaVersion: number };
  store: RuntimeStore;
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

function pragmaNumber(database: DatabaseSync, statement: string, key: string): number {
  const row = asRow(database.prepare(statement).get());
  return row === undefined ? 0 : numberValue(row, key);
}

export async function latestMigrationVersion(migrationsDirectory: string): Promise<number> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name))
    .reduce((latest, entry) => Math.max(latest, Number.parseInt(entry.name.split("_", 1)[0] ?? "0", 10)), 0);
}

export async function applyMigrations(database: DatabaseSync, migrationsDirectory: string) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )`);
  const entries = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const version = Number.parseInt(entry.name.split("_", 1)[0] ?? "", 10);
    const existing = database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version);
    if (existing !== undefined) continue;
    const sql = await readFile(path.join(migrationsDirectory, entry.name), "utf8");
    const requiresForeignKeysOff = /^-- joi:migration foreign-keys-off\b/u.test(sql);
    if (requiresForeignKeysOff) database.exec("PRAGMA foreign_keys = OFF");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      if (requiresForeignKeysOff && database.prepare("PRAGMA foreign_key_check").all().length > 0) {
        throw new Error("migration_foreign_key_check_failed");
      }
      database.prepare("INSERT INTO schema_migrations (version, filename, applied_at) VALUES (?, ?, ?)")
        .run(version, entry.name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      if (requiresForeignKeysOff) database.exec("PRAGMA foreign_keys = ON");
    }
  }
}

export async function openRuntimeDatabase(input: { databasePath: string; migrationsDirectory: string }): Promise<RuntimeDatabase> {
  await mkdir(path.dirname(input.databasePath), { recursive: true });
  let database = new DatabaseSync(input.databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  let migrationFailure = false;
  try {
    await applyMigrations(database, input.migrationsDirectory);
  } catch {
    database.close();
    database = new DatabaseSync(input.databasePath, { readOnly: true });
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA query_only = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    migrationFailure = true;
  }
  const store = new SqliteRuntimeStore(database);
  let closed = false;

  const runtime: RuntimeDatabase = {
    backupTo(destinationPath) {
      if (closed) return Promise.reject(new Error("Runtime database is closed."));
      return backup(database, destinationPath);
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
    inspect() {
      const journal = asRow(database.prepare("PRAGMA journal_mode").get());
      const schema = asRow(database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get());
      return {
        busyTimeout: pragmaNumber(database, "PRAGMA busy_timeout", "timeout"),
        foreignKeys: pragmaNumber(database, "PRAGMA foreign_keys", "foreign_keys") === 1,
        journalMode: journal === undefined ? "unknown" : textValue(journal, "journal_mode"),
        ...(migrationFailure ? { migrationFailure: "migration_failed" as const } : {}),
        mode: migrationFailure ? "read-only-recovery" as const : "read-write" as const,
        queryOnly: pragmaNumber(database, "PRAGMA query_only", "query_only") === 1,
        schemaVersion: schema === undefined ? 0 : numberValue(schema, "version"),
      };
    },
    store,
    transaction<T>(operation: (connection: DatabaseSync) => T) {
      if (migrationFailure) return operation(database);
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(database);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return runtime;
}
