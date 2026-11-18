import { convertToLlm,serializeConversation } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConversationHandoffPort } from "../../application/ports/conversations.js";
import { restorePiSnapshot } from "./joi-pi-session.js";
import type { PiNativeSessionStore } from "./pi-native-session-store.js";
import { DomainError } from "../../domain/errors.js";
import { HANDOFF_BUSINESS_BOUNDARY, HANDOFF_CONTEXT_HEADING, HANDOFF_INTRO, handoffBusinessFacts, importedHandoffContext } from "./conversation-session.js";

/** Canonical history references and official context serialization require no handoff model call. */
export class ConversationHandoff implements ConversationHandoffPort {
  constructor(private readonly sessions?: PiNativeSessionStore) {}
  async read(input: Parameters<ConversationHandoffPort["read"]>[0]): Promise<unknown[]> {
    const result: unknown[] = [];
    for (const segment of input.segments) {
      const native = segment.engine === "pi-core" ? await this.sessions?.readContext(["conversation",input.workbenchId,input.conversationId,...(segment.segmentId === "legacy" ? [] : [segment.segmentId])],segment.state?.piNativeSession) : undefined;
      if (segment.state?.piNativeSession !== undefined && this.sessions === undefined) throw new DomainError("conversation_session_invalid","Native history is unavailable.");
      const snapshot = segment.state?.piSession;
      const manager = native?.manager ?? (snapshot === undefined ? undefined : restorePiSnapshot(".",snapshot));
      result.push({ segmentId: segment.segmentId,engine: segment.engine,partnerId: segment.partnerId,predecessorId: segment.predecessorId,
        entries: manager?.getEntries() ?? segment.state?.messages ?? [] });
    }
    return result;
  }
  async build(input: Parameters<ConversationHandoffPort["build"]>[0]) {
    const source = input.source;
    if (source.state?.piNativeSession !== undefined && this.sessions === undefined) throw new DomainError("conversation_handoff_failed","Native history is unavailable for handoff.");
    const identity = ["conversation",input.workbenchId,input.conversationId,...(source.segmentId === "legacy" ? [] : [source.segmentId])];
    const native = source.engine === "pi-core" ? await this.sessions?.readContext(identity,source.state?.piNativeSession) : undefined;
    const snapshot = source.state?.piSession;
    const manager = native?.manager ?? (snapshot === undefined ? undefined : restorePiSnapshot(".",snapshot));
    const fork = input.fork;
    let messages: unknown[];
    if (fork !== undefined) {
      const cutoff = manager?.getEntries().findLast(entry => entry.type === "custom" && entry.customType === "joi.work_result"
        && (entry.data as { actionId?: unknown } | undefined)?.actionId === fork.turnId);
      if (cutoff !== undefined && manager !== undefined) {
        manager.branch(cutoff.id);
        messages = manager.buildSessionContext().messages;
      } else if (manager === undefined && fork.messageCount !== undefined && source.state !== undefined) {
        messages = source.state.messages.slice(0,fork.messageCount);
      } else {
        messages = fork.inherited?.messages ?? [];
      }
    } else {
      messages = manager?.buildSessionContext().messages ?? source.state?.messages ?? [];
    }
    const serialized = (messages as AgentMessage[]).map(message => importedHandoffContext(message)
      ?? serializeConversation(convertToLlm([message]))).filter(Boolean).join("\n\n");
    const facts = JSON.stringify(handoffBusinessFacts(input.history));
    // A fork's business turns exist only on the source, so later segment handoffs must keep those facts in the inherited context.
    const context = fork === undefined ? serialized : [serialized,`Forked turn facts: ${facts}`].filter(Boolean).join("\n\n");
    const text = [HANDOFF_INTRO,
      `Source: conversation=${input.conversationId}; segment=${source.segmentId}; partner=${source.partnerId}; engine=${source.engine}${fork === undefined ? "" : `; turn=${fork.turnId}`}. Original source history remains available in the source conversation's execution records.`,
      HANDOFF_CONTEXT_HEADING,context,`${HANDOFF_BUSINESS_BOUNDARY}${fork === undefined ? facts : "[]"}`].join("\n\n");
    const parent = fork === undefined ? native?.reference ?? source.state?.piNativeSession : undefined;
    return { engine: source.engine,messages: [{ role: "user",content: text,timestamp: 0 }],
      handoff: { sourceSegmentId: source.segmentId,...(parent === undefined ? {} : { sourcePiSession: parent }) } };
  }
}
