import { NativeAgentEventProjector } from "../../src/main/application/partners/native-agent-event-projector.js";
import { normalizeAgentConversationEntries } from "../../src/main/application/partners/agent-conversation-presentation.js";
import { parseNativeAgentSessionRef, toNativeAgentSessionRef } from "../../src/main/application/partners/native-agent-session-reference.js";

describe("native agent event surface", () => {
  it("keeps the actual time of each event and the start time of a streaming message", () => {
    let now = new Date("2026-09-18T10:03:00.000Z");
    const projector = new NativeAgentEventProjector({ now: () => now });
    projector.apply({ type: "message", role: "agent", parts: [{ type: "text", text: "first" }] });
    now = new Date("2026-09-18T10:04:00.000Z");
    projector.apply({ type: "message", role: "agent", parts: [{ type: "text", text: " delta" }] });
    projector.apply({ type: "tool_activity", toolName: "read", state: "started" });
    now = new Date("2026-09-18T10:05:00.000Z");
    projector.apply({ type: "tool_activity", toolName: "read", state: "completed" });
    const entries = normalizeAgentConversationEntries({ agentId: "a", runId: "r", startedAt: "2026-09-18T10:00:00.000Z" }, projector.snapshot());
    expect(entries.map(entry => entry.createdAt)).toEqual(["2026-09-18T10:03:00.000Z", "2026-09-18T10:04:00.000Z", "2026-09-18T10:05:00.000Z"]);
    expect(entries[0]?.text).toBe("first delta");
  });
  it.each(["claude", "codex", "a2a"])("projects %s-origin events through the same safe surface", () => {
    const projector = new NativeAgentEventProjector();
    projector.apply({ type: "status", state: "working" });
    projector.apply({ type: "message", role: "agent", parts: [{ type: "text", text: "shared result" }] });
    projector.apply({ type: "status", state: "completed" });

    expect(projector.snapshot()).toEqual([{ kind: "MARKDOWN", role: "AGENT", text: "shared result" }]);
  });

  it("projects safe A2A-like messages, tool lifecycle, artifacts and failures without payload details", () => {
    const projector = new NativeAgentEventProjector();
    projector.apply({ type: "message", role: "user", parts: [{ type: "text", text: "do it" }] });
    projector.apply({ type: "status", state: "working" });
    projector.apply({ type: "tool_activity", toolName: "shell", state: "started" });
    projector.apply({ type: "tool_activity", toolName: "shell", state: "completed" });
    projector.apply({ type: "message", role: "agent", parts: [{ type: "text", text: "done" }] });
    projector.apply({ type: "artifact", artifact: { mimeType: "text/plain", name: "result.txt", size: 4 } });

    expect(projector.snapshot()).toEqual([
      { kind: "MARKDOWN", role: "USER", text: "do it" },
      { kind: "TOOL_CALL", role: "TOOL", toolName: "shell" },
      { kind: "TOOL_RESULT", role: "TOOL", text: "执行完成", toolName: "shell" },
      { kind: "MARKDOWN", role: "AGENT", text: "done" },
      { artifact: { mimeType: "text/plain", name: "result.txt", size: 4 }, kind: "ARTIFACT", role: "AGENT" },
    ]);
    expect(JSON.stringify(projector.snapshot())).not.toContain("arguments");
  });

  it("handles deltas, failed tools, file parts and safe failure statuses", () => {
    const projector = new NativeAgentEventProjector();
    projector.apply({
      type: "message",
      role: "user",
      parts: [
        { type: "text", text: "" },
        { type: "file", mimeType: "text/plain", name: "input.txt", size: 3 },
      ],
    });
    projector.apply({ type: "message", role: "agent", parts: [{ type: "text", text: "part " }] });
    projector.apply({ type: "message", role: "agent", parts: [{ type: "text", text: "two" }] });
    projector.apply({ type: "tool_activity", toolName: "shell", state: "failed" });
    projector.apply({ type: "artifact", artifact: { mimeType: "text/plain", name: "output.txt", size: 0 } });
    projector.apply({ type: "status", state: "failed" });
    projector.apply({ type: "status", state: "auth-required" });

    expect(projector.snapshot()).toEqual([
      { artifact: { mimeType: "text/plain", name: "input.txt", size: 3 }, kind: "ARTIFACT", role: "USER" },
      { kind: "MARKDOWN", role: "AGENT", text: "part two" },
      { kind: "TOOL_RESULT", role: "TOOL", text: "执行失败", toolName: "shell" },
      { artifact: { mimeType: "text/plain", name: "output.txt", size: 0 }, kind: "ARTIFACT", role: "AGENT" },
      { kind: "ERROR", role: "SYSTEM", text: "搭档调用失败" },
      { kind: "ERROR", role: "SYSTEM", text: "需要完成身份验证" },
    ]);
  });

  it("versions native session references and rejects legacy or cross-engine references", () => {
    const ref = toNativeAgentSessionRef("codex", "thread-safe");
    expect(ref).toBe("native-agent:v1:codex:thread-safe");
    expect(parseNativeAgentSessionRef(ref, "codex")).toBe("thread-safe");
    expect(parseNativeAgentSessionRef(ref, "claude")).toBeUndefined();
    expect(parseNativeAgentSessionRef("legacy-thread", "codex")).toBeUndefined();
  });
});
