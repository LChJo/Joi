import {
  TOOL_CALL_SUMMARY_MAX_CHARS,
  TOOL_TRACE_MAX_BODY_CHARS,
  TOOL_TRACE_TRUNCATION_NOTE,
  toolCallCommand,
  toolCallLabel,
  toolCallResultBody,
  toolCallSummary,
} from "../../src/main/application/partners/tool-trace-presentation.js";

describe("tool trace presentation", () => {
  describe("inline summary", () => {
    it("collapses a multi-line command into one readable line instead of keeping its first line", () => {
      const summary = toolCallSummary("bash", { command: "set -euo pipefail\ncd /repo && npm test\n" });
      expect(summary).toBe("set -euo pipefail cd /repo && npm test");
    });

    it("abbreviates absolute paths and masks credentials", () => {
      const summary = toolCallSummary("bash", { command: "cd C:\\Users\\owner\\deep\\repo && curl -H 'Authorization: Bearer abcdefghijklmnop' x" });
      expect(summary).toContain("C:\\…\\owner\\deep\\repo");
      expect(summary).toContain("Bearer [redacted]");
      expect(summary).not.toContain("C:\\Users");
      expect(summary).not.toContain("abcdefghijklmnop");
    });

    it("holds the post-sanitize cap once abbreviation has rewritten the line", () => {
      // A bare four-segment path is the one shape abbreviation lengthens (`C:\a\b\c\d` gains
      // an elision marker), so masking can still push a line past the limit. The second cap
      // is what enforces the invariant.
      const summary = toolCallSummary("bash", { command: `${"cd C:\\a\\b\\c\\d && ".repeat(20)}npm test` });
      expect(summary.length).toBe(TOOL_CALL_SUMMARY_MAX_CHARS);
      expect(summary.endsWith("…")).toBe(true);
    });

    it("bounds the regex input before sanitizing an oversized argument", () => {
      const summary = toolCallSummary("write", { content: "x".repeat(200_000), path: "/tmp/out" });
      expect(summary).toBe("/tmp/out · 200000 字符");
      expect(summary.length).toBeLessThanOrEqual(TOOL_CALL_SUMMARY_MAX_CHARS);
    });

    it.each([
      ["read", { path: "/tmp/a.md" }, "/tmp/a.md"],
      ["ls", { path: "/tmp/dir" }, "/tmp/dir"],
      ["read", { path: "/tmp/a/b/c/d.md" }, "/…/b/c/d.md"],
      ["grep", { ignoreCase: true, path: "/tmp/src", pattern: "monitor" }, "monitor @ /tmp/src"],
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

    it.each([
      ["js", { code: "return 1" }, "return 1"],
      ["find", { path: "relative/src" }, "relative/src"],
      ["write", { path: "notes.md" }, "notes.md"],
      ["edit", { file_path: "notes.md", new_string: "next" }, "notes.md · 4 字符"],
      ["grep", { path: "src" }, "src"],
      ["grep", { pattern: "needle" }, "needle"],
      ["get_search_content", { findText: "needle" }, "needle"],
      ["get_search_content", { url: "https://example.com" }, "https://example.com"],
    ])("covers alternate readable arguments for %s", (toolName, args, expected) => {
      expect(toolCallSummary(toolName, args)).toBe(expected);
    });

    it("uses bounded serialization for empty, deep and unserializable argument shapes", () => {
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let index = 0; index < 8; index += 1) {
        const next: Record<string, unknown> = {};
        cursor.next = next;
        cursor = next;
      }
      expect(toolCallSummary("bash", { command: "", fallback: true })).toBe('{"command":"","fallback":true}');
      expect(toolCallSummary("write", { content: "", path: "" })).toBe('{"content":"","path":""}');
      expect(toolCallSummary("mystery", deep)).toContain("[…]");
      expect(toolCallSummary("mystery", Symbol("value"))).toBe("[unserializable]");
      expect(toolCallSummary("mystery", { value: 1n })).toBe("[unserializable]");
      expect(toolCallSummary("mystery", [1, null, "three"])).toBe('[1,null,"three"]');
    });

    it.each([
      ["js", { language: "javascript" }],
      ["read", { encoding: "utf8" }],
      ["grep", { pattern: "", path: "" }],
      ["web_search", { limit: 3 }],
      ["fetch_content", { timeout: 10 }],
      ["get_search_content", { responseId: "", findText: "", url: "" }],
      ["ask_user", { required: true }],
    ])("falls back to JSON when %s has no readable primary field", (toolName, args) => {
      expect(toolCallSummary(toolName, args)).toBe(JSON.stringify(args));
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

    it("projects alternate command fields and omits empty edit sections", () => {
      expect(toolCallCommand("js", { code: "return 2" }).body).toBe("return 2");
      expect(toolCallCommand("shell", { command: "" }).body).toBe('{"command":""}');
      expect(toolCallCommand("write", { content: "body", file_path: "relative.md" }).body).toBe("relative.md\n\nbody");
      expect(toolCallCommand("write", { content: "", path: "" }).body).toBe("");
      expect(toolCallCommand("edit", { old_string: "before", path: "relative.md" }).body)
        .toBe("relative.md\n\n--- before\nbefore");
      expect(toolCallCommand("edit", { file_path: "relative.md", new_str: "after" }).body)
        .toBe("relative.md\n\n--- after\nafter");
      expect(toolCallCommand("unknown", null).body).toBe("null");
    });

    it("falls back safely for raw and incomplete command inputs", () => {
      expect(toolCallCommand("bash", "npm test").body).toBe("npm test");
      expect(toolCallCommand("js", { language: "javascript" }).body).toBe('{"language":"javascript"}');
      expect(toolCallCommand("edit", { oldText: "before" }).body).toBe("--- before\nbefore");
      expect(toolCallCommand("custom", { flag: true }).body).toBe('{"flag":true}');
    });

    it("flattens pi tool output and appends details", () => {
      expect(toolCallResultBody({ content: [{ text: "line one", type: "text" }, { text: "line two", type: "text" }], details: { exitCode: 1 } }).body)
        .toBe("line one\nline two\n--- details ---\n{\"exitCode\":1}");
      expect(toolCallResultBody("plain").body).toBe("plain");
      expect(toolCallResultBody({ content: [] }).body).toBe('{"content":[]}');
    });

    it("accepts string blocks, string content and ignores non-text output blocks", () => {
      expect(toolCallResultBody({ content: ["one", null, { text: 2 }, { text: "two" }] }).body).toBe("one\ntwo");
      expect(toolCallResultBody({ content: "direct", details: {} }).body).toBe("direct");
      expect(toolCallResultBody(["array-result"]).body).toBe('["array-result"]');
      expect(toolCallResultBody({ content: 42, details: null }).body).toBe('{"content":42,"details":null}');
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

  describe("tool labels", () => {
    it.each([
      ["Bash", "运行命令"],
      ["command_execution", "运行命令"],
      ["Read", "读取文件"],
      ["Write", "写入文件"],
      ["edit", "修改文件"],
      ["apply_patch", "修改文件"],
      ["file_change", "修改文件"],
      ["find", "检索文件"],
      ["grep", "检索文件"],
      ["ls", "检索文件"],
      ["web_search", "检索网络"],
      ["fetch_content", "检索网络"],
      ["get_search_content", "检索网络"],
      ["ask_user", "询问用户"],
      ["custom_tool", "custom_tool"],
    ])("maps %s to a bounded user-facing label", (toolName, expected) => {
      expect(toolCallLabel(toolName)).toBe(expected);
    });

    it("bounds unknown tool identifiers", () => {
      expect(toolCallLabel("x".repeat(500))).toHaveLength(TOOL_CALL_SUMMARY_MAX_CHARS);
    });
  });
});
