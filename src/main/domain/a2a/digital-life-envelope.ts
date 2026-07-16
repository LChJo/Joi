import { RUNTIME_EXTENSION_URI } from "../../../shared/product.js";
import { DomainError } from "../errors.js";

const MAX_WAKE_BYTES = 128 * 1024;
export const LIFE_ACTION_KINDS = [
  "affair.upsert",
  "alarm.cancel",
  "alarm.schedule",
  "delegate",
  "express",
  "interaction.answer",
  "memory.append",
  "memory.revise",
  "sleep",
  "todo.upsert",
] as const;

const ACTION_KINDS = new Set<string>(LIFE_ACTION_KINDS);

export interface WakeEnvelopeV1 extends Record<string, unknown> {
  kind: "wake";
  turnId: string;
  version: 1;
  wakeId: string;
}

export interface LifeAction extends Record<string, unknown> {
  actionId: string;
  kind: string;
}

export interface LifeActionEnvelopeV1 extends Record<string, unknown> {
  actionSetId: string;
  actions: LifeAction[];
  consciousnessResidue: string;
  continueWake: boolean;
  kind: "actions";
  turnId: string;
  version: 1;
  wakeId: string;
}

export interface ReadinessAckV1 extends Record<string, unknown> {
  actionId: string;
  kind: "readiness_ack";
  noSideEffects: true;
  supportedActions: string[];
  version: 1;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new DomainError("action_schema_invalid", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(record: Record<string, unknown>, key: string, options: { allowEmpty?: boolean; max?: number } = {}): string {
  const value = record[key];
  if (typeof value !== "string" || (!options.allowEmpty && value.trim() === "") || (options.max !== undefined && value.length > options.max)) {
    throw new DomainError("action_schema_invalid", `${key} must be a valid string.`);
  }
  return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DomainError("action_schema_invalid", `${key} must be an array of strings.`);
  }
  return value as string[];
}

function objectArray(record: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new DomainError("action_schema_invalid", `${key} must be an array.`);
  return value.map((item) => objectValue(item, key));
}

function requireLiteral(record: Record<string, unknown>, key: string, expected: unknown): void {
  if (record[key] !== expected) throw new DomainError("action_schema_invalid", `${key} must equal ${String(expected)}.`);
}

function optionalStringValue(record: Record<string, unknown>, key: string, max = 32_000): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new DomainError("action_schema_invalid", `${key} must be a valid string.`);
  }
  return value;
}

function optionalEnum(record: Record<string, unknown>, key: string, values: readonly string[]): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== "string" || !values.includes(value))) {
    throw new DomainError("action_schema_invalid", `${key} is invalid.`);
  }
}

function optionalNumber(record: Record<string, unknown>, key: string, minimum: number, maximum: number): void {
  const value = record[key];
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum)) {
    throw new DomainError("action_schema_invalid", `${key} is invalid.`);
  }
}

function optionalArtifactIds(record: Record<string, unknown>): void {
  const value = record.artifactIds;
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 8 || value.some((item) => typeof item !== "string" || item.trim() === "")
    || new Set(value).size !== value.length) {
    throw new DomainError("action_schema_invalid", "artifactIds must contain at most 8 unique Artifact ids.");
  }
}

function optionalMemoryEntities(record: Record<string, unknown>): void {
  const value = record.entities;
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 16) {
    throw new DomainError("action_schema_invalid", "entities must contain at most 16 entity references.");
  }
  for (const candidate of value) {
    const entity = objectValue(candidate, "entity");
    stringValue(entity, "name", { max: 160 });
    stringValue(entity, "type", { max: 64 });
    stringValue(entity, "relation", { max: 80 });
  }
}

function isoDateValue(record: Record<string, unknown>, key: string): void {
  const value = stringValue(record, key);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new DomainError("action_schema_invalid", `${key} must be an ISO timestamp with timezone.`);
  }
}

function validateActionShape(action: LifeAction): void {
  switch (action.kind) {
    case "express":
      stringValue(action, "text", { max: 32_000 });
      return;
    case "sleep":
      stringValue(action, "reason", { max: 1000 });
      return;
    case "memory.append":
      stringValue(action, "content", { max: 32_000 });
      optionalEnum(action, "memoryKind", ["EPISODIC", "SEMANTIC", "CARD"]);
      optionalNumber(action, "confidence", 0, 1);
      optionalStringValue(action, "affairId");
      optionalStringValue(action, "sourceEventId");
      optionalMemoryEntities(action);
      return;
    case "memory.revise":
      stringValue(action, "memoryId");
      stringValue(action, "content", { max: 32_000 });
      optionalNumber(action, "confidence", 0, 1);
      optionalMemoryEntities(action);
      return;
    case "affair.upsert":
      stringValue(action, "title", { max: 500 });
      optionalStringValue(action, "affairId");
      optionalStringValue(action, "summary", 4000);
      optionalEnum(action, "status", ["OPEN", "RUNNING", "WAITING", "DONE", "FAILED", "CANCELED"]);
      optionalEnum(action, "waitingReason", ["HUMAN_INPUT", "AUTH", "AGENT_RESULT", "TIME", "BUDGET"]);
      if (action.status === "WAITING" && action.waitingReason === undefined) {
        throw new DomainError("action_schema_invalid", "WAITING Affair requires waitingReason.");
      }
      return;
    case "todo.upsert":
      stringValue(action, "title", { max: 500 });
      optionalStringValue(action, "todoId");
      optionalStringValue(action, "affairId");
      optionalEnum(action, "status", ["OPEN", "IN_PROGRESS", "DONE", "CANCELED"]);
      if (action.dueAt !== undefined && action.dueAt !== null) isoDateValue(action, "dueAt");
      return;
    case "alarm.schedule":
      isoDateValue(action, "at");
      stringValue(action, "reason", { max: 1000 });
      optionalStringValue(action, "alarmId");
      optionalStringValue(action, "affairId");
      optionalNumber(action, "repeatEveryMinutes", 1, 525_600);
      optionalEnum(action, "recurrenceRule", ["DAILY", "WEEKDAYS", "WEEKENDS", "WEEKLY"]);
      if (action.repeatEveryMinutes !== undefined && action.recurrenceRule !== undefined) {
        throw new DomainError("action_schema_invalid", "Alarm must use either an interval or a calendar recurrence rule.");
      }
      optionalEnum(action, "creator", ["AGENT", "HUMAN"]);
      if (action.allowQuietHours !== undefined && typeof action.allowQuietHours !== "boolean") {
        throw new DomainError("action_schema_invalid", "allowQuietHours must be boolean.");
      }
      return;
    case "alarm.cancel":
      stringValue(action, "alarmId");
      return;
    case "delegate":
      stringValue(action, "agentConnectionId");
      stringValue(action, "task", { max: 32_000 });
      optionalStringValue(action, "title", 500);
      optionalStringValue(action, "affairId");
      optionalArtifactIds(action);
      return;
    case "interaction.answer":
      stringValue(action, "interactionId");
      stringValue(action, "answer", { max: 32_000 });
      return;
    default:
      throw new DomainError("action_schema_invalid", `Action kind ${action.kind} is unknown.`);
  }
}

export function validateWakeEnvelope(value: unknown): WakeEnvelopeV1 {
  const serializedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (serializedBytes > MAX_WAKE_BYTES) throw new DomainError("wake_envelope_too_large", "WakeEnvelope exceeds 128 KiB.");
  const envelope = objectValue(value, "WakeEnvelope");
  requireLiteral(envelope, "version", 1);
  requireLiteral(envelope, "kind", "wake");
  stringValue(envelope, "wakeId");
  stringValue(envelope, "turnId");
  stringValue(envelope, "now");
  const life = objectValue(envelope.life, "life");
  for (const key of ["lifeId", "name", "personaVersion", "persona", "timezone"]) stringValue(life, key);
  stringArray(life, "principles");
  objectArray(envelope, "events");
  objectArray(envelope, "memories");
  objectArray(envelope, "todos");
  objectArray(envelope, "collaborators");
  const rhythm = objectValue(envelope.rhythm, "rhythm");
  objectValue(rhythm.quietHours, "quietHours");
  objectValue(rhythm.budget, "budget");
  objectArray(rhythm, "nextSchedules");
  const protocol = objectValue(envelope.protocol, "protocol");
  requireLiteral(protocol, "extensionUri", RUNTIME_EXTENSION_URI);
  stringArray(protocol, "allowedActions");
  if (!Number.isInteger(protocol.maxTurnsRemaining) || Number(protocol.maxTurnsRemaining) < 0) {
    throw new DomainError("action_schema_invalid", "maxTurnsRemaining must be a non-negative integer.");
  }
  return envelope as WakeEnvelopeV1;
}

export function validateLifeActionEnvelope(
  value: unknown,
  expected: { allowedActions: string[]; turnId: string; wakeId: string },
): LifeActionEnvelopeV1 {
  const envelope = objectValue(value, "LifeActionEnvelope");
  requireLiteral(envelope, "version", 1);
  requireLiteral(envelope, "kind", "actions");
  if (stringValue(envelope, "wakeId") !== expected.wakeId) throw new DomainError("action_schema_invalid", "wakeId does not match the active Wake.");
  if (stringValue(envelope, "turnId") !== expected.turnId) throw new DomainError("action_schema_invalid", "turnId does not match the active Turn.");
  stringValue(envelope, "actionSetId");
  stringValue(envelope, "consciousnessResidue", { allowEmpty: true, max: 32_000 });
  if (typeof envelope.continueWake !== "boolean") throw new DomainError("action_schema_invalid", "continueWake must be boolean.");
  const actions = objectArray(envelope, "actions").map((item) => {
    const action: LifeAction = { ...item, actionId: stringValue(item, "actionId"), kind: stringValue(item, "kind") };
    if (!ACTION_KINDS.has(action.kind) || !expected.allowedActions.includes(action.kind)) {
      throw new DomainError("action_schema_invalid", `Action kind ${action.kind} is not allowed.`);
    }
    validateActionShape(action);
    return action;
  });
  const ids = actions.map((action) => action.actionId);
  if (new Set(ids).size !== ids.length) throw new DomainError("action_schema_invalid", "ActionEnvelope contains duplicate actionId values.");
  return { ...envelope, actions } as LifeActionEnvelopeV1;
}

export function parseLifeActionEnvelope(input: {
  artifacts: { name: string; text: string }[];
  parts: { data: unknown; extensionUri?: string; kind: string }[];
}): unknown {
  const dataParts = input.parts.filter((part) => part.kind === "data" && part.extensionUri === RUNTIME_EXTENSION_URI);
  if (dataParts.length > 1) throw new DomainError("action_schema_invalid", "Expected exactly one joi DataPart.");
  if (dataParts.length === 1) return dataParts[0]?.data;

  const responseArtifacts = input.artifacts.filter((artifact) => artifact.name === "response.txt");
  const blocks = responseArtifacts.flatMap((artifact) => [...artifact.text.matchAll(/```digital-life-actions\s*([\s\S]*?)```/g)]);
  if (blocks.length !== 1) throw new DomainError("action_schema_invalid", "Expected exactly one digital-life-actions fenced block.");
  try {
    return JSON.parse(blocks[0]?.[1] ?? "");
  } catch {
    throw new DomainError("action_schema_invalid", "joi action JSON is invalid.");
  }
}

export function validateReadinessAck(
  value: unknown,
  expected: { expectedActionId: string; requiredActions: string[] },
): ReadinessAckV1 {
  const ack = objectValue(value, "ReadinessAck");
  requireLiteral(ack, "version", 1);
  requireLiteral(ack, "kind", "readiness_ack");
  requireLiteral(ack, "noSideEffects", true);
  if (stringValue(ack, "actionId") !== expected.expectedActionId) throw new DomainError("agent_readiness_failed", "Readiness actionId does not match.");
  const supportedActions = stringArray(ack, "supportedActions");
  if (expected.requiredActions.some((action) => !supportedActions.includes(action))) {
    throw new DomainError("agent_readiness_failed", "Agent does not support the required joi actions.");
  }
  return { ...ack, supportedActions } as ReadinessAckV1;
}
