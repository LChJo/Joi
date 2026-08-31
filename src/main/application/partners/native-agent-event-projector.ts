import type { AgentConversationDraft } from "./agent-conversation-presentation.js";
import type { NativeAgentEvent } from "../ports/native-agent-events.js";

export class NativeAgentEventProjector {
  readonly #drafts: AgentConversationDraft[] = [];

  apply(event: NativeAgentEvent): void {
    if (event.type === "message") {
      for (const part of event.parts) {
        if (part.type === "text" && part.text !== "") {
          this.#appendText(event.role === "user" ? "USER" : "AGENT", part.text);
        } else if (part.type !== "text") {
          this.#drafts.push({
            artifact: { mimeType: part.mimeType, name: part.name, size: part.size },
            kind: "ARTIFACT",
            role: event.role === "user" ? "USER" : "AGENT",
          });
        }
      }
      return;
    }
    if (event.type === "tool_activity") {
      const toolName = event.toolName.slice(0, 120);
      this.#drafts.push(event.state === "started"
        ? { kind: "TOOL_CALL", role: "TOOL", toolName }
        : { kind: "TOOL_RESULT", role: "TOOL", text: event.state === "completed" ? "执行完成" : "执行失败", toolName });
      return;
    }
    if (event.type === "artifact") {
      this.#drafts.push({ artifact: { ...event.artifact }, kind: "ARTIFACT", role: "AGENT" });
    } else if (event.state === "failed" || event.state === "auth-required") {
      this.#drafts.push({ kind: "ERROR", role: "SYSTEM", text: event.state === "auth-required" ? "需要完成身份验证" : "搭档调用失败" });
    }
  }

  snapshot(): AgentConversationDraft[] {
    return this.#drafts.map((draft) => ({
      ...draft,
      ...(draft.artifact === undefined ? {} : { artifact: { ...draft.artifact } }),
    }));
  }

  #appendText(role: "AGENT" | "USER", text: string): void {
    const last = this.#drafts.at(-1);
    if (last?.kind === "MARKDOWN" && last.role === role) {
      last.text = `${last.text ?? ""}${text}`;
    } else {
      this.#drafts.push({ kind: "MARKDOWN", role, text });
    }
  }
}
