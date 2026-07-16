export type EventPriority = 0 | 1 | 2 | 3;

export interface EventTypeDefinition {
  autoWake: boolean;
  contextPolicy: string;
  debounce?: { merge: "accumulate" | "count" | "latest"; windowMs: number };
  defaultPriority: EventPriority;
  maxAttempts: number;
  payloadSchema: string;
  type: string;
}

type PayloadValidator = (payload: Record<string, unknown>) => boolean;

function objectPayload(value: unknown): value is Record<string, unknown> {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function nonEmptyText(payload: Record<string, unknown>, key: string): boolean {
  return typeof payload[key] === "string" && payload[key].trim() !== "";
}

const MESSAGE: PayloadValidator = (payload) => nonEmptyText(payload, "text");
const ALARM: PayloadValidator = (payload) => nonEmptyText(payload, "alarmId") && nonEmptyText(payload, "occurrenceAt");
const AGENT: PayloadValidator = (payload) => nonEmptyText(payload, "agentConnectionId") || nonEmptyText(payload, "invocationId");
const ANY: PayloadValidator = () => true;

const DEFINITIONS: [Omit<EventTypeDefinition, "payloadSchema" | "type">, string, PayloadValidator][] = [
  [{ autoWake: true, contextPolicy: "system", defaultPriority: 1, maxAttempts: 8 }, "system.birth", ANY],
  [{ autoWake: true, contextPolicy: "recovery", defaultPriority: 0, maxAttempts: 10 }, "system.recovery", ANY],
  [{ autoWake: true, contextPolicy: "agent-health", debounce: { merge: "latest", windowMs: 60_000 }, defaultPriority: 1, maxAttempts: 10 }, "system.agent_unavailable", AGENT],
  [{ autoWake: true, contextPolicy: "verbatim-current-message", defaultPriority: 1, maxAttempts: 8 }, "human.message", MESSAGE],
  [{ autoWake: true, contextPolicy: "interaction", defaultPriority: 1, maxAttempts: 8 }, "human.input_answered", ANY],
  [{ autoWake: true, contextPolicy: "interaction", defaultPriority: 0, maxAttempts: 8 }, "human.auth_resolved", ANY],
  [{ autoWake: true, contextPolicy: "rhythm", debounce: { merge: "latest", windowMs: 30 * 60_000 }, defaultPriority: 2, maxAttempts: 6 }, "schedule.morning_plan", ANY],
  [{ autoWake: true, contextPolicy: "rhythm", debounce: { merge: "latest", windowMs: 30 * 60_000 }, defaultPriority: 2, maxAttempts: 6 }, "schedule.evening_review", ANY],
  [{ autoWake: true, contextPolicy: "memory-maintenance", debounce: { merge: "latest", windowMs: 60 * 60_000 }, defaultPriority: 3, maxAttempts: 6 }, "schedule.memory_metabolism", ANY],
  [{ autoWake: true, contextPolicy: "alarm", defaultPriority: 2, maxAttempts: 10 }, "alarm.fired", ALARM],
  [{ autoWake: true, contextPolicy: "todo", defaultPriority: 2, maxAttempts: 8 }, "todo.due", ANY],
  [{ autoWake: true, contextPolicy: "todo", debounce: { merge: "latest", windowMs: 5 * 60_000 }, defaultPriority: 2, maxAttempts: 8 }, "todo.reminder", ANY],
  [{ autoWake: true, contextPolicy: "todo", defaultPriority: 1, maxAttempts: 8 }, "todo.user_changed", ANY],
  [{ autoWake: true, contextPolicy: "alarm", defaultPriority: 1, maxAttempts: 8 }, "alarm.user_changed", ANY],
  [{ autoWake: true, contextPolicy: "delegation-result", defaultPriority: 2, maxAttempts: 8 }, "agent.completed", AGENT],
  [{ autoWake: true, contextPolicy: "delegation-result", defaultPriority: 1, maxAttempts: 8 }, "agent.failed", AGENT],
  [{ autoWake: true, contextPolicy: "interaction", defaultPriority: 1, maxAttempts: 8 }, "agent.input_required", AGENT],
  [{ autoWake: true, contextPolicy: "interaction", defaultPriority: 0, maxAttempts: 8 }, "agent.auth_required", AGENT],
  [{ autoWake: true, contextPolicy: "artifact", defaultPriority: 2, maxAttempts: 8 }, "agent.artifact_created", AGENT],
  [{ autoWake: true, contextPolicy: "budget", debounce: { merge: "latest", windowMs: 60_000 }, defaultPriority: 2, maxAttempts: 6 }, "budget.reset", ANY],
  [{ autoWake: true, contextPolicy: "budget", debounce: { merge: "latest", windowMs: 60_000 }, defaultPriority: 1, maxAttempts: 6 }, "budget.exhausted", ANY],
  [{ autoWake: true, contextPolicy: "idle", debounce: { merge: "latest", windowMs: 60 * 60_000 }, defaultPriority: 3, maxAttempts: 4 }, "idle.explore", ANY],
  [{ autoWake: true, contextPolicy: "memory-correction", defaultPriority: 2, maxAttempts: 8 }, "memory.corrected", ANY],
  [{ autoWake: true, contextPolicy: "memory-correction", defaultPriority: 1, maxAttempts: 8 }, "memory.forgotten", ANY],
];

export class EventTypeRegistry {
  readonly version = 1;
  private readonly entries = new Map(DEFINITIONS.map(([definition, type, validator]) => [type, {
    definition: { ...definition, payloadSchema: `event://v1/${type}`, type } satisfies EventTypeDefinition,
    validator,
  }]));

  definition(type: string): EventTypeDefinition | undefined {
    return this.entries.get(type)?.definition;
  }

  inspect(type: string, payload: unknown): { autoWake: boolean; registered: boolean; valid: boolean } {
    const entry = this.entries.get(type);
    if (entry === undefined) return { autoWake: false, registered: false, valid: true };
    const valid = objectPayload(payload) && entry.validator(payload);
    return { autoWake: valid && entry.definition.autoWake, registered: true, valid };
  }

  types(): string[] {
    return [...this.entries.keys()];
  }
}

export const EVENT_TYPE_REGISTRY = new EventTypeRegistry();
