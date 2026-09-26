import {
  TOOL_CALL_SUMMARY_MAX_CHARS,
  TOOL_TRACE_MAX_BODY_CHARS,
  TOOL_TRACE_TRUNCATION_NOTE,
  toolCallCommand,
  toolCallResultBody,
  toolCallSummary,
} from "../../src/main/application/partners/tool-trace-presentation.js";

describe("tool trace presentation", () => {
  describe("inline summary", () => {
    it("collapses a multi-line command into one readable line instead of keeping its first line", () => {
      const summary = toolCallSummary("bash", { command: "set -euo pipefail\ncd /repo && npm test\n" });
      expect(summary).toBe("set -euo pipefail cd [redacted-path] && npm test");
    });

    it("redacts absolute paths and masks credentials", () => {
      const summary = toolCallSummary("bash", { command: "cd C:\\Users\\owner\\repo && curl -H 'Authorization: Bearer abcdefghijklmnop' x" });
      expect(summary).toContain("[redacted-path]");
      expect(summary).toContain("Bearer [redacted]");
      expect(summary).not.toContain("C:\\Users");
      expect(summary).not.toContain("abcdefghijklmnop");
    });

    it("holds the post-sanitize cap even when masking makes the line much longer", () => {
      // `[redacted-path]` is longer than the `/a` it replaces, so one path per short token
      // grows the line far past the limit. The second cap is what enforces the invariant.
      const summary = toolCallSummary("bash", { command: "/a ".repeat(60) });
      expect(summary.length).toBe(TOOL_CALL_SUMMARY_MAX_CHARS);
      expect(summary.endsWith("…")).toBe(true);
    });

    it("bounds the regex input before sanitizing an oversized argument", () => {
      const summary = toolCallSummary("write", { content: "x".repeat(200_000), path: "/tmp/out" });
      expect(summary).toBe("[redacted-path] · 200000 字符");
      expect(summary.length).toBeLessThanOrEqual(TOOL_CALL_SUMMARY_MAX_CHARS);
    });

    it.each([
      ["read", { path: "/tmp/a.md" }, "[redacted-path]"],
      ["ls", { path: "/tmp/dir" }, "[redacted-path]"],
      ["grep", { ignoreCase: true, path: "/tmp/src", pattern: "monitor" }, "monitor @ [redacted-path]"],
      ["web_search", { query: "pi agent core" }, "pi agent core"],
      ["fetch_content", { url: "https://example.com/doc" }, "https://example.com/doc"],
      ["ask_user", { question: "Which account?" }, "Which account?"],
    ])("projects %s arguments as one line", (toolName, args, expected) => {
      expect(toolCallSummary(toolName, args)).toBe(expected);
    });

    it("falls back to bounded JSON for unknown tools and survives cyclic or absent arguments", () => {
      const cyclic: Record<string, unknown> = { pattern: "a" };
      cyclic.self = cyclic;
      expect(toolCallSummary("mystery", { a: 1 })).toBe('{"a":1}');
      expect(toolCallSummary("mystery", cyclic)).toContain('"pattern":"a"');
      expect(toolCallSummary("bash", undefined)).toBe("");
      expect(toolCallSummary("bash", "raw string args")).toBe("raw string args");
    });
  });

  describe("private trace body", () => {
    it("keeps absolute paths while masking credentials", () => {
      // The whole point of the trace channel: a bash command is mostly its paths.
      const trace = toolCallCommand("bash", { command: "cd C:\\work\\repo && cat config apiKey=super-secret-value" });
      expect(trace.body).toContain("C:\\work\\repo");
      expect(trace.body).toContain("apiKey=[redacted]");
      expect(trace.body).not.toContain("super-secret-value");
      expect(trace.truncated).toBe(false);
    });

    it("preserves newlines so a script stays readable", () => {
      expect(toolCallCommand("bash", { command: "set -e\nnpm ci\nnpm test" }).body).toBe("set -e\nnpm ci\nnpm test");
    });

    it("shows a file tool's target and change", () => {
      expect(toolCallCommand("write", { content: "hello", path: "/tmp/out.md" }).body).toBe("/tmp/out.md\n\nhello");
      expect(toolCallCommand("edit", { newText: "b", oldText: "a", path: "/tmp/f.ts" }).body)
        .toBe("/tmp/f.ts\n\n--- before\na\n\n--- after\nb");
    });

    it("flattens pi tool output and appends details", () => {
      expect(toolCallResultBody({ content: [{ text: "line one", type: "text" }, { text: "line two", type: "text" }], details: { exitCode: 1 } }).body)
        .toBe("line one\nline two\n--- details ---\n{\"exitCode\":1}");
      expect(toolCallResultBody("plain").body).toBe("plain");
      expect(toolCallResultBody({ content: [] }).body).toBe('{"content":[]}');
    });

    it("truncates each body independently at the character budget", () => {
      const command = toolCallCommand("bash", { command: "x".repeat(20_000) });
      expect(command.truncated).toBe(true);
      expect(command.body.length).toBe(TOOL_TRACE_MAX_BODY_CHARS + TOOL_TRACE_TRUNCATION_NOTE.length);
      expect(command.body.endsWith(TOOL_TRACE_TRUNCATION_NOTE)).toBe(true);

      const result = toolCallResultBody("y".repeat(TOOL_TRACE_MAX_BODY_CHARS));
      expect(result.truncated).toBe(false);
      expect(result.body.length).toBe(TOOL_TRACE_MAX_BODY_CHARS);
    });
  });
});
