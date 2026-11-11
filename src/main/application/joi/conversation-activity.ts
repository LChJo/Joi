import type { ConversationActivityDto,ConversationActivityEntryDto,ConversationContextDto,ConversationEntryDto,ConversationThinkingDto } from "../../../shared/conversations.js";
import { sanitizeAgentConversationText } from "../partners/agent-conversation-presentation.js";

/** Activities keep their first observed position when authoritative output snapshots are replaced. */
export class ConversationActivity {
  readonly #positions = new Map<string,number>();
  readonly #activities = new Map<string,ConversationActivityEntryDto>();
  constructor(private readonly turnId: string,private readonly now: () => string) {}

  context(context: ConversationContextDto): void { this.#set("context",{ type: "CONTEXT",context }); }
  thinking(thinking: ConversationThinkingDto): void {
    const summary = thinking.summary === undefined ? undefined : sanitizeAgentConversationText(thinking.summary);
    const prior = this.#activities.get(`thinking:${thinking.phaseId}`)?.activity;
    this.#set(`thinking:${thinking.phaseId}`,{ type: "THINKING",thinking: {
      ...(prior?.type === "THINKING" ? prior.thinking : {}),phaseId: thinking.phaseId,state: thinking.state,
      ...(thinking.startedAt === undefined ? {} : { startedAt: thinking.startedAt }),
      ...(thinking.durationMs === undefined || !Number.isFinite(thinking.durationMs) ? {} : { durationMs: Math.max(0,thinking.durationMs) }),
      ...(summary === undefined ? {} : { summary: summary.slice(0,2048),summaryTruncated: thinking.summaryTruncated === true || summary.length > 2048 }),
    } });
  }
  interrupt(): void {
    for (const entry of this.#activities.values()) if (entry.activity.type === "THINKING" && entry.activity.thinking.state === "STARTED") {
      this.thinking({ ...entry.activity.thinking,state: "INTERRUPTED" });
    }
  }
  project(base: readonly ConversationEntryDto[]): ConversationEntryDto[] {
    for (const entry of base) this.#position(entry.entryId);
    return [...base,...this.#activities.values()].sort((a,b) => this.#position(a.entryId) - this.#position(b.entryId)).map((entry,index) => ({ ...entry,sequence: index + 1 }));
  }
  #position(id: string): number {
    const prior = this.#positions.get(id);if (prior !== undefined) return prior;
    const position = this.#positions.size;this.#positions.set(id,position);return position;
  }
  #set(key: string,activity: ConversationActivityDto): void {
    const prior = this.#activities.get(key),entryId = `${this.turnId}:activity:${key}`;
    this.#position(entryId);
    this.#activities.set(key,{ entryId,sequence: 0,createdAt: prior?.createdAt ?? this.now(),kind: "ACTIVITY",role: "SYSTEM",activity });
  }
}
