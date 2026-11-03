import { DomainError } from "../../domain/errors.js";
import { RhythmPolicy } from "../../domain/rhythm/rhythm-policy.js";
import { validateCreateLife, validateUpdateLife, type CreateLifeInput, type UpdateLifeInput } from "../../domain/lives/life.js";
import type { Clock, IdGenerator, LifeOverview, LifeStore, SsePublisher } from "../ports/runtime-store.js";
import type { LifeFileDeletionPort } from "../ports/life-file-ports.js";

export class LifeService {
  private readonly rhythm = new RhythmPolicy();

  constructor(private readonly dependencies: { clock: Clock; files?: LifeFileDeletionPort; ids: IdGenerator; publisher: SsePublisher; store: LifeStore }) {}

  async create(input: CreateLifeInput, options: { idempotencyKey?: string } = {}) {
    const normalized = validateCreateLife(input);
    const now = this.dependencies.clock.now().toISOString();
    const result = await this.dependencies.store.createLife({
      ...normalized,
      createdAt: now,
      lifeId: this.dependencies.ids.next("life"),
      personaVersionId: this.dependencies.ids.next("persona"),
    }, options.idempotencyKey);
    await this.dependencies.publisher.publish(result.event);
    return result.life;
  }

  async get(lifeId: string) {
    const life = await this.dependencies.store.getLife(lifeId);
    if (life === null) throw new DomainError("life_not_found", "Life was not found.");
    return life;
  }

  async list(input: { after?: { createdAt: string; lifeId: string }; limit: number }) {
    const page = await this.dependencies.store.listLives(input);
    const now = this.dependencies.clock.now();
    const items = await Promise.all(page.items.map(async (life): Promise<LifeOverview> => {
      const facts = await this.dependencies.store.getLifeOverviewFacts({
        lifeId: life.lifeId,
        localDate: this.rhythm.localDate(now, life.timezone),
        now: now.toISOString(),
      });
      const candidates = [
        facts.nextAlarmAt,
        ...facts.schedules.map((schedule) => this.rhythm.nextOccurrence(now, schedule.timezone, schedule.localTime).toISOString()),
      ].filter((value): value is string => value !== undefined).sort();
      return { ...life, ...facts, ...(candidates[0] === undefined ? {} : { nextWakeAt: candidates[0] }) };
    }));
    return { ...page, items };
  }

  async update(lifeId: string, input: UpdateLifeInput) {
    const patch = validateUpdateLife(input);
    const result = await this.dependencies.store.updateLife({
      lifeId,
      now: this.dependencies.clock.now().toISOString(),
      patch,
      personaVersionId: this.dependencies.ids.next("persona"),
    });
    if (result === null) throw new DomainError("life_not_found", "Life was not found.");
    await this.dependencies.publisher.publish(result.event);
    return result.life;
  }

  async delete(lifeId: string) {
    const staged = await this.dependencies.files?.stage(lifeId);
    try {
      const event = await this.dependencies.store.deleteLife(lifeId, this.dependencies.clock.now().toISOString());
      if (event === null) throw new DomainError("life_not_found", "Life was not found.");
      if (staged !== undefined && this.dependencies.files !== undefined) await this.dependencies.files.commit(staged);
      await this.dependencies.publisher.publish(event);
    } catch (error) {
      if (staged !== undefined) await this.dependencies.files?.rollback(staged);
      throw error;
    }
  }

  async archive(lifeId: string) {
    const result = await this.dependencies.store.archiveLife(lifeId, this.dependencies.clock.now().toISOString());
    if (result === null) throw new DomainError("life_not_found", "Life was not found.");
    await this.dependencies.publisher.publish(result.event);
    return result.life;
  }

  async getDeletionImpact(lifeId: string) {
    const impact = await this.dependencies.store.getLifeDeletionImpact(lifeId);
    if (impact === null) throw new DomainError("life_not_found", "Life was not found.");
    return impact;
  }

  async changePrimaryAgent(lifeId: string, toAgentConnectionId: string) {
    const life = await this.get(lifeId);
    if (life.state !== "PAUSED") {
      throw new DomainError("life_primary_agent_change_requires_pause", "Pause the Life before changing its primary Agent.");
    }
    if (life.mainAgentConnectionId === toAgentConnectionId) {
      throw new DomainError("life_primary_agent_unchanged", "The selected Agent is already primary for this Life.");
    }
    const context = await this.dependencies.store.getLifeHandoffContext(lifeId);
    if (context === null) throw new DomainError("life_not_found", "Life was not found.");
    const summary = boundedUtf8([
      `Life: ${life.name}`,
      `Persona: ${life.personaSummary}`,
      ...(life.initialGoal === undefined ? [] : [`Initial goal: ${life.initialGoal}`]),
      ...(life.principles.length === 0 ? [] : [`Principles: ${life.principles.join("; ")}`]),
      ...(context.residue === undefined ? [] : [`Consciousness residue: ${context.residue}`]),
      ...context.affairs.map((affair) => `Affair [${affair.status}]: ${affair.title}${affair.summary === undefined ? "" : ` — ${affair.summary}`}`),
      ...context.todos.map((todo) => `Todo [${todo.status}]: ${todo.title}`),
      ...context.cards.map((card) => `Memory card: ${card}`),
    ].join("\n"), 4096);
    const result = await this.dependencies.store.changePrimaryAgent({
      fromAgentConnectionId: life.mainAgentConnectionId,
      handoffId: this.dependencies.ids.next("handoff"),
      lifeId,
      now: this.dependencies.clock.now().toISOString(),
      summary,
      toAgentConnectionId: toAgentConnectionId.trim(),
    });
    await this.dependencies.publisher.publish(result.event);
    return { handoff: result.handoff, life: result.life };
  }

  getPrimaryAgentHandoffs(lifeId: string) {
    return this.dependencies.store.listPrimaryAgentHandoffs(lifeId);
  }
}

function boundedUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = "\n[handoff truncated]";
  let output = "";
  for (const character of value) {
    if (encoder.encode(output + character + suffix).byteLength > maxBytes) break;
    output += character;
  }
  return output.trimEnd() + suffix;
}
