import { draftAgentConversation, normalizeAgentConversationEntries, sanitizeAgentConversationText } from "../../src/main/application/partners/agent-conversation-presentation.js";

describe("Agent conversation presentation", () => {
  it("redacts private values, preserves display kinds and splits large markdown", () => {
    const entries = normalizeAgentConversationEntries({
      agentId: "agent-1",
      runId: "run-1",
      startedAt: "2026-08-03T12:00:00.000Z",
    }, [
      { kind: "MARKDOWN", role: "AGENT", text: `完成 C:\\Users\\owner\\secret.txt Bearer abcdefghijklmnop\n${"x".repeat(70_000)}` },
      { kind: "TOOL_CALL", role: "TOOL", text: "read_file /home/owner/private.md cookie=session-secret", toolName: "read_file" },
      { artifact: { mimeType: "text/plain", name: "/workspace/private/report.txt", size: 42 }, kind: "ARTIFACT", role: "AGENT" },
    ]);

    expect(entries.filter((entry) => entry.kind === "MARKDOWN").length).toBeGreaterThan(2);
    expect(entries.map((entry) => entry.text ?? "").join("\n")).not.toMatch(/C:\\Users|\/home\/owner|abcdefghijklmnop/u);
    expect(entries.map((entry) => entry.text ?? "").join("\n")).toContain("[redacted-path]");
    expect(entries.map((entry) => entry.text ?? "").join("\n")).toContain("Bearer [redacted]");
    expect(entries.map((entry) => entry.text ?? "").join("\n")).not.toContain("session-secret");
    expect(entries.at(-1)).toMatchObject({ artifact: { name: "[redacted-path]", size: 42 }, kind: "ARTIFACT" });
    expect(new Set(entries.map((entry) => entry.entryId)).size).toBe(entries.length);
  });

  it("projects bounded tool metadata and textual results without reasoning or arguments", () => {
    const cyclic: Record<string, unknown> = { role: "tool", text: "cyclic result" };
    cyclic.self = cyclic;
    const drafts = draftAgentConversation("task", "final", [
      [{ type: "tool_call", name: "read", input: { path: "/secret" } }],
      { arguments: { token: "secret" }, toolName: "edit", type: "tool_use" },
      { role: "tool", text: "text result" },
      { result: "result value", tool_name: "shell", type: "tool_result" },
      { content: "content value", role: "tool" },
      { reasoning: "PRIVATE_REASONING", wrapper: cyclic },
    ]);
    expect(drafts).toEqual(expect.arrayContaining([
      { kind: "MARKDOWN", role: "USER", text: "task" },
      { kind: "TOOL_CALL", role: "TOOL", toolName: "read" },
      { kind: "TOOL_CALL", role: "TOOL", toolName: "edit" },
      { kind: "TOOL_CALL", role: "TOOL", toolName: "shell" },
      { kind: "TOOL_RESULT", role: "TOOL", text: "text result" },
      { kind: "TOOL_RESULT", role: "TOOL", text: "result value" },
      { kind: "TOOL_RESULT", role: "TOOL", text: "content value" },
      { kind: "MARKDOWN", role: "AGENT", text: "final" },
    ]));
    expect(JSON.stringify(drafts)).not.toContain("PRIVATE_REASONING");
    expect(JSON.stringify(drafts)).not.toContain("secret");
    expect(draftAgentConversation("task", "  ", [null, "primitive"])).toEqual([{ kind: "MARKDOWN", role: "USER", text: "task" }]);
    expect(sanitizeAgentConversationText("https://example.com/x apiKey=abc csrf_token=def /workspace/a"))
      .toBe("https://example.com/x apiKey=[redacted] csrf_token=[redacted] [redacted-path]");
  });

  it("ignores non-tool names, blank or non-text results and traversal beyond the display bound", () => {
    let deep: Record<string, unknown> = { role: "tool", text: "too deep" };
    for (let index = 0; index < 8; index += 1) deep = { child: deep };
    const crowded = Array.from({ length: 202 }, (_, index) => ({ role: "tool", text: `result-${String(index)}` }));
    const drafts = draftAgentConversation("task", "", [
      { name: "ordinary-name", type: "message" },
      { content: 42, role: "tool" },
      { role: "tool", text: "   " },
      deep,
      crowded,
    ]);
    expect(drafts.some((entry) => entry.kind === "TOOL_CALL")).toBe(false);
    expect(JSON.stringify(drafts)).not.toContain("too deep");
    expect(drafts.length).toBeLessThanOrEqual(202);
    expect(normalizeAgentConversationEntries({ agentId: "agent-empty", runId: "run-empty", startedAt: "2026-08-03T12:00:00.000Z" }, [
      { kind: "MARKDOWN", role: "SYSTEM", text: "" },
    ])).toMatchObject([{ text: "" }]);
  });
});
