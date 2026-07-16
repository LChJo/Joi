import { validateWakeEnvelope, type WakeEnvelopeV1 } from "../../domain/a2a/digital-life-envelope.js";
import { DomainError } from "../../domain/errors.js";
import { RUNTIME_EXTENSION_URI } from "../../../shared/product.js";
import type { Clock, RuntimeStore } from "../ports/runtime-store.js";
import type { LifeEvent, WakeRecord, WakeTurnRecord } from "../ports/runtime-core-ports.js";

export class WakeContextAssembler {
  constructor(private readonly dependencies: { clock: Clock; store: RuntimeStore }) {}

  async assemble(input: {
    allowedActions: string[];
    events: LifeEvent[];
    turn: WakeTurnRecord;
    wake: WakeRecord;
  }): Promise<WakeEnvelopeV1> {
    const life = await this.dependencies.store.getLife(input.wake.lifeId);
    if (life === null) throw new DomainError("life_not_found", "Life was not found.");
    const now = this.dependencies.clock.now();
    const localDate = localDateInTimezone(now, life.timezone);
    const affairId = input.events.find((event) => event.affairId !== undefined)?.affairId;
    const query = input.events.map((event) => JSON.stringify(event.payload)).join(" ").slice(0, 4000);
    const [residue, agents, affairs, todos, schedules, budget, recalled] = await Promise.all([
      this.dependencies.store.getConsciousnessResidue(life.lifeId),
      this.dependencies.store.listLifeCollaborators(life.lifeId),
      this.dependencies.store.listAffairs(life.lifeId),
      this.dependencies.store.listTodos(life.lifeId),
      this.dependencies.store.listSchedules(life.lifeId),
      this.dependencies.store.getDailyBudget(life.lifeId, localDate, now.toISOString()),
      this.dependencies.store.recallMemories({
        ...(affairId === undefined ? {} : { affairId }),
        lifeId: life.lifeId,
        limit: 16,
        now: now.toISOString(),
        query,
      }),
    ]);
    const memories: Record<string, unknown>[] = [];
    let memoryBytes = 0;
    for (const memory of recalled) {
      const bytes = new TextEncoder().encode(memory.content).byteLength;
      if (memoryBytes + bytes > 32 * 1024) break;
      memoryBytes += bytes;
      memories.push({
        ...(memory.affairId === undefined ? {} : { affairId: memory.affairId }),
        confidence: memory.confidence,
        content: memory.content,
        kind: memory.kind,
        memoryId: memory.memoryId,
        sourceBoundary: "context-data",
      });
    }
    const currentAffair = affairId === undefined ? undefined : affairs.find((affair) => affair.affairId === affairId);
    const envelope = {
      collaborators: agents
        .filter((agent) => new Set(["ACTIVE", "COLLABORATOR_ONLY"]).has(agent.status))
        .map((agent) => ({
          agentId: agent.agentConnectionId,
          healthy: agent.readiness === true,
          name: agent.name,
          skills: agent.skills ?? [],
        })),
      ...(residue === null ? {} : { consciousnessResidue: residue.text }),
      ...(currentAffair === undefined ? {} : { affair: currentAffair }),
      events: input.events.map((event) => ({
        ...(event.affairId === undefined ? {} : { affairId: event.affairId }),
        eventId: event.eventId,
        occurredAt: event.occurredAt,
        payload: event.payload,
        source: event.source,
        type: event.type,
      })),
      kind: "wake",
      life: {
        lifeId: life.lifeId,
        name: life.name,
        persona: life.personaSummary,
        personaVersion: input.wake.personaVersionId,
        principles: life.principles,
        ...(life.role === undefined ? {} : { role: life.role }),
        timezone: life.timezone,
      },
      memories,
      now: now.toISOString(),
      protocol: {
        allowedActions: input.allowedActions,
        extensionUri: RUNTIME_EXTENSION_URI,
        maxTurnsRemaining: Math.max(0, 4 - input.turn.turnNumber),
      },
      rhythm: {
        budget: {
          autonomousWakesRemaining: Math.max(0, budget.autonomousWakesLimit - budget.autonomousWakesUsed),
          idleExplorationsRemaining: Math.max(0, budget.idleExplorationsLimit - budget.idleExplorationsUsed),
          invocationsRemaining: Math.max(0, budget.invocationsLimit - budget.invocationsUsed),
          localDate,
        },
        nextSchedules: schedules.filter((schedule) => schedule.enabled)
          .map((schedule) => ({ at: `${localDate}T${schedule.localTime}`, kind: schedule.kind })),
        quietHours: { end: life.quietEnd, start: life.quietStart },
      },
      todos: todos.filter((todo) => todo.status === "OPEN" || todo.status === "IN_PROGRESS").slice(0, 50),
      turnId: input.turn.turnId,
      version: 1,
      wakeId: input.wake.wakeId,
    };
    return validateWakeEnvelope(envelope);
  }
}

function localDateInTimezone(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}
