import { COMPLETION_SUMMARY_LIMIT, draftAgentConversation, maskSecretText, normalizeAgentConversationEntries, normalizeCompletionSummary, sanitizeAgentConversationText, stripPathRedactions } from "../../src/main/application/partners/agent-conversation-presentation.js";

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
      { kind: "TOOL_RESULT", role: "TOOL", text: "result value", toolName: "shell" },
      { kind: "TOOL_RESULT", role: "TOOL", text: "content value" },
      { kind: "MARKDOWN", role: "AGENT", text: "final" },
    ]));
    expect(JSON.stringify(drafts)).not.toContain("PRIVATE_REASONING");
    expect(JSON.stringify(drafts)).not.toContain("secret");
    expect(draftAgentConversation("task", "  ", [null, "primitive"])).toEqual([{ kind: "MARKDOWN", role: "USER", text: "task" }]);
    expect(sanitizeAgentConversationText("https://example.com/x apiKey=abc csrf_token=def /workspace/a"))
      .toBe("https://example.com/x apiKey=[redacted] csrf_token=[redacted] [redacted-path]");
  });

  it("keeps one entry per call with its correlation id and reads pi's nested tool output", () => {
    const drafts = draftAgentConversation("task", "final", [
      { content: [{ text: "I will look", type: "text" }, { arguments: { command: "npm test" }, id: "toolu_a", name: "bash", type: "toolCall" }], role: "assistant" },
      { content: [{ text: "42 passing", type: "text" }], role: "toolResult", toolCallId: "toolu_a", toolName: "bash" },
      { content: [{ arguments: { command: "npm run lint" }, id: "toolu_b", name: "bash", type: "toolCall" }], role: "assistant" },
      { content: [{ text: "clean", type: "text" }], role: "toolResult", toolCallId: "toolu_b", toolName: "bash" },
    ]);

    // Two same-named calls stay two entries: collapsing them by name would drop the id that
    // opens each call's private body.
    expect(drafts.filter((entry) => entry.kind === "TOOL_CALL")).toEqual([
      { kind: "TOOL_CALL", role: "TOOL", toolCallId: "toolu_a", toolName: "bash" },
      { kind: "TOOL_CALL", role: "TOOL", toolCallId: "toolu_b", toolName: "bash" },
    ]);
    expect(drafts.filter((entry) => entry.kind === "TOOL_RESULT").map((entry) => entry.text)).toEqual(["42 passing", "clean"]);
    expect(drafts.at(-1)).toEqual({ kind: "MARKDOWN", role: "AGENT", text: "final" });
    // Arguments never travel as text on this surface.
    expect(JSON.stringify(drafts)).not.toContain("npm test");
  });

  it("drops path placeholders for card-facing text while keeping secret masking", () => {
    expect(stripPathRedactions(sanitizeAgentConversationText("C:\\work\\prd.md 审查一下这个prd方案"))).toBe("审查一下这个prd方案");
    expect(stripPathRedactions(sanitizeAgentConversationText("done /workspace/a apiKey=abc"))).toBe("done apiKey=[redacted]");
    expect(stripPathRedactions("## 结论\n\n[redacted-path] 已隐藏。")).toBe("## 结论\n\n已隐藏。");
  });

  it("keeps user paths visible while masking secrets for local card projections", () => {
    expect(maskSecretText("C:\\work\\prd.md 审查一下这个prd方案")).toBe("C:\\work\\prd.md 审查一下这个prd方案");
    expect(maskSecretText("done /workspace/a apiKey=abc Bearer abcdefghijklmnop")).toBe("done /workspace/a apiKey=[redacted] Bearer [redacted]");
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

  it("keeps completion summary markdown structure instead of flattening it", () => {
    const summary = normalizeCompletionSummary("## 结论\r\n\r\n- 甲  \n- 乙\n\n\n\n| 维度 | 结果 |\n| --- | --- |\n| 回归 | 通过 |\n");
    expect(summary).toBe("## 结论\n\n- 甲\n- 乙\n\n| 维度 | 结果 |\n| --- | --- |\n| 回归 | 通过 |");
    expect(normalizeCompletionSummary(" 单行结论 ")).toBe("单行结论");
  });

  it("bounds completion summaries at a line boundary and closes dangling code fences", () => {
    const rows = Array.from({ length: 400 }, (_, index) => `| 行${String(index)} | 结果 |`).join("\n");
    const truncated = normalizeCompletionSummary(`| 维度 | 结果 |\n| --- | --- |\n${rows}`);
    expect(truncated.length).toBeLessThanOrEqual(COMPLETION_SUMMARY_LIMIT);
    expect(truncated.split("\n").at(-1)).toMatch(/^\| 行\d+ \| 结果 \|$/u);

    const fenced = normalizeCompletionSummary(`前置\n\n\`\`\`text\n${"代码行\n".repeat(2000)}`);
    expect(fenced.length).toBeLessThanOrEqual(COMPLETION_SUMMARY_LIMIT + 4);
    expect((fenced.match(/^```/gmu) ?? []).length % 2).toBe(0);
  });
});
