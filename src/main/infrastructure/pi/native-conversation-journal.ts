import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { PartnerExecutionContext } from "../../application/ports/partner-instances.js";
import type { PartnerRunRequest } from "../../application/ports/partner-execution.js";
import { toNativeAgentSessionRef } from "../../application/partners/native-agent-session-reference.js";
import { conversationSeedMessages, conversationPrompt, nativeHistoryPrompt, sessionAssistant } from "./conversation-session.js";

/** Private transcript persistence is independent of the payload-free native event projection. */
export class NativeConversationJournal {
  readonly messages: AgentMessage[];
  #reference: string | undefined;
  #streamIndex: number | undefined;
  constructor(private readonly engine: "codex" | "claude-code",request: PartnerRunRequest,private readonly context: PartnerExecutionContext) {
    this.messages = [...conversationSeedMessages(request,context.sessionState)];
    this.#reference = context.sessionState?.engine === engine ? context.sessionState.externalSessionRef : undefined;
    if (request.workspaceExecution?.phase !== "WRITE_RUNNING") this.messages.push({ role: "user",content: conversationPrompt(request),timestamp: Date.now() });
  }
  history(): string { return nativeHistoryPrompt(this.messages.slice(0,-1)); }
  async reference(id: string): Promise<void> {
    this.#reference = toNativeAgentSessionRef(this.engine === "codex" ? "codex" : "claude",id);
    await this.save();
  }
  async save(): Promise<void> {
    await this.context.saveSession?.({ engine: this.engine,messages: this.messages,
      ...(this.#reference === undefined ? {} : { externalSessionRef: this.#reference }) });
  }
  async delta(text: string): Promise<void> {
    if (this.#streamIndex === undefined) { this.#streamIndex = this.messages.length;this.messages.push(sessionAssistant([{ type: "text",text }],this.engine)); }
    else {
      const message = this.messages[this.#streamIndex];
      if (message?.role === "assistant") {
        const block = message.content.at(-1);
        if (block?.type === "text") block.text += text;else message.content.push({ type: "text",text });
      }
    }
    await this.save();
  }
  async assistant(content: unknown[]): Promise<void> {
    const useful = content.filter(block => ["text","toolCall"].includes((block as { type: string }).type));
    if (useful.length === 0) return;
    const message = sessionAssistant(useful,this.engine);
    const calls = useful.filter(block => (block as { type: string }).type === "toolCall") as { id: string }[];
    const existing = calls.length === 0 ? -1 : this.messages.findIndex(item => item.role === "assistant" && Array.isArray(item.content)
      && item.content.some(block => block.type === "toolCall" && calls.some(call => call.id === block.id)));
    if (this.#streamIndex !== undefined) { this.messages[this.#streamIndex] = message;this.#streamIndex = undefined; }
    else if (existing >= 0) this.messages[existing] = message;
    else this.messages.push(message);
    await this.save();
  }
  async final(text: string): Promise<void> {
    if (text === "") return;
    if (JSON.stringify(this.messages.at(-1)).includes(JSON.stringify(text))) { await this.save();return; }
    await this.assistant([{ type: "text",text }]);
  }
  async tool(id: string,name: string,args: unknown,result?: string,isError = false): Promise<void> {
    const exists = this.messages.some(message => message.role === "assistant" && Array.isArray(message.content)
      && message.content.some(block => block.type === "toolCall" && block.id === id));
    if (!exists) {
      if (this.engine === "claude-code") {
        if (this.#streamIndex === undefined) { this.#streamIndex = this.messages.length;this.messages.push(sessionAssistant([],this.engine)); }
        const message = this.messages[this.#streamIndex];
        if (message?.role === "assistant") { message.content.push({ type: "toolCall",id,name,arguments: args as JsonObject });message.stopReason = "toolUse"; }
        await this.save();
      } else await this.assistant([{ type: "toolCall",id,name,arguments: args }]);
    }
    if (result !== undefined) {
      this.#streamIndex = undefined;
      const message: AgentMessage = { role: "toolResult",toolCallId: id,toolName: name,content: [{ type: "text",text: result }],isError,timestamp: Date.now() };
      const index = this.messages.findIndex(item => item.role === "toolResult" && item.toolCallId === id);
      if (index < 0) this.messages.push(message);else this.messages[index] = message;
      await this.save();
    }
  }
}
