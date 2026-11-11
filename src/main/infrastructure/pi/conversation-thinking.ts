import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { ConversationThinkingDto } from "../../../shared/conversations.js";
import { sanitizeAgentConversationText } from "../../application/partners/agent-conversation-presentation.js";

/** The observer accepts lifecycle signals and explicitly public summaries, never raw thinking. */
export class ConversationThinking {
  readonly #phases = new Map<string,{ value: ConversationThinkingDto;start?: number }>();
  #message = 0;
  constructor(private readonly publish: ((value: ConversationThinkingDto) => Promise<void>) | undefined,private readonly prefix: string,private readonly now = Date.now) {}

  async start(key: string): Promise<void> {
    if (this.publish === undefined || this.#phases.has(key)) return;
    const start = this.now(),value: ConversationThinkingDto = { phaseId: `${this.prefix}:thinking:${String(this.#phases.size + 1)}`,state: "STARTED",startedAt: new Date(start).toISOString() };
    this.#phases.set(key,{ value,start });await this.#emit(value);
  }
  async end(key: string,publicSummary?: string): Promise<void> {
    if (this.publish === undefined) return;
    const phase = this.#phases.get(key);
    if (phase !== undefined && phase.value.state !== "STARTED") return;
    const summary = publicSummary === undefined ? undefined : sanitizeAgentConversationText(publicSummary);
    const value: ConversationThinkingDto = { ...(phase?.value ?? { phaseId: `${this.prefix}:thinking:${String(this.#phases.size + 1)}` }),state: "COMPLETED",
      ...(phase?.start === undefined ? {} : { durationMs: Math.max(0,this.now() - phase.start) }),
      ...(summary === undefined || summary === "" ? {} : { summary: summary.slice(0,2048),summaryTruncated: summary.length > 2048 }) };
    this.#phases.set(key,{ value });await this.#emit(value);
  }
  async interrupt(): Promise<void> {
    for (const phase of this.#phases.values()) if (phase.value.state === "STARTED") {
      phase.value = { ...phase.value,state: "INTERRUPTED",...(phase.start === undefined ? {} : { durationMs: Math.max(0,this.now() - phase.start) }) };
      await this.#emit(phase.value);
    }
  }
  async pi(event: AgentEvent): Promise<void> {
    if (event.type === "message_start" && event.message.role === "assistant") this.#message++;
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "thinking_start") await this.start(`${String(this.#message)}:${String(update.contentIndex)}`);
      else if (update.type === "thinking_end") await this.end(`${String(this.#message)}:${String(update.contentIndex)}`);
    } else if (event.type === "message_end" && event.message.role === "assistant") {
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted") await this.interrupt();
      else for (const [key,phase] of this.#phases) if (phase.value.state === "STARTED") await this.end(key);
    }
  }
  async #emit(value: ConversationThinkingDto): Promise<void> {
    try { await this.publish?.(value); } catch { /* Display persistence does not control execution. */ }
  }
}
