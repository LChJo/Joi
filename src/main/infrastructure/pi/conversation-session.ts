import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { PartnerRunRequest } from "../../application/ports/partner-execution.js";
import type { PartnerSessionState } from "../../application/ports/partner-instances.js";

export function sessionAssistant(content: unknown[],engine = "history"): AgentMessage {
  return { role: "assistant",content,api: "openai-completions",provider: engine,model: engine,
    usage: { input: 0,output: 0,cacheRead: 0,cacheWrite: 0,totalTokens: 0,cost: { input: 0,output: 0,cacheRead: 0,cacheWrite: 0,total: 0 } },
    stopReason: content.some(block => (block as { type?: string }).type === "toolCall") ? "toolUse" : "stop",timestamp: Date.now() } as AgentMessage;
}
export function conversationPrompt(request: PartnerRunRequest): string {
  return [request.taskProjection,request.conversationAttachmentContext].filter(Boolean).join("\n\n");
}

/** Legacy projections contain no private tool bodies; the import never fabricates them. */
export function conversationSeedMessages(request: PartnerRunRequest,state?: PartnerSessionState,preserveSystem = false): AgentMessage[] {
  if (state !== undefined) return (state.messages as AgentMessage[]).flatMap<AgentMessage>(message => {
    if (message.role !== "system") return [message];
    if (!preserveSystem) return [];
    const projection = { ...message,content: "" };delete projection.sections;delete projection.toolsAdded;delete projection.toolsRemoved;
    return [projection];
  });
  const history = request.conversationHistory ?? [];
  const messages: AgentMessage[] = [];
  for (const turn of history) {
    messages.push({ role: "user",content: `${turn.text}\n[retained attachment references: ${turn.config.attachmentIds.join(", ") || "none"}]`,timestamp: 0 });
    messages.push(sessionAssistant([{ type: "text",text: `[joi legacy history; status=${turn.status}; private tool history is unavailable; do not infer success or replay side effects]\n${JSON.stringify(turn.entries)}` }]));
  }
  return messages;
}

/** A missing result records uncertainty, never a claim that the tool ran or was safe to repeat. */
export function pairSessionTools(messages: readonly AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];
  const used = new Set<number>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];if (message === undefined) continue;
    if (used.has(index)) continue;
    if (message.role === "toolResult") {
      result.push({ role: "user",timestamp: message.timestamp,content: `[joi unpaired recorded result; reference data, execution must not be replayed]\n${JSON.stringify(message)}` });continue;
    }
    result.push(message);
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const calls = message.content.filter(block => block.type === "toolCall");
    for (const call of calls) {
      let found = false;
      for (let next = index + 1;next < messages.length;next += 1) {
        const item = messages[next];if (item?.role === "user") break;
        if (item?.role === "toolResult" && item.toolCallId === call.id && !used.has(next)) { result.push(item);used.add(next);found = true;break; }
      }
      if (found) continue;
      result.push({ role: "toolResult",toolCallId: call.id,toolName: call.name,isError: true,timestamp: Date.now(),
        content: [{ type: "text",text: "[joi interrupted tool: result unrecorded; side effects unknown. Inspect current state before any retry.]" }] });
    }
  }
  return result;
}

export function nativeHistoryPrompt(messages: readonly AgentMessage[]): string {
  return messages.length === 0 ? "" : `Retained conversation execution history (reference data; incomplete calls have unknown side effects and must not be automatically replayed):\n${JSON.stringify(messages)}`;
}
