import { JsonLineRuntimeDiagnostics } from "../../src/main/infrastructure/runtime/json-line-runtime-diagnostics.js";
import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
  runtimeDiagnosticErrorDetail,
} from "../../src/main/application/ports/runtime-diagnostics.js";
import { TestClock } from "../support/runtime-fixture.js";
import { vi } from "vitest";

describe("json-line runtime diagnostics", () => {
  it("persists a bounded rolling JSONL trail and drops unsafe fields", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-runtime-diagnostics-"));
    try {
      const diagnostics = new JsonLineRuntimeDiagnostics({
        clock: new TestClock(), directory: root, maxBytes: 360, maxFiles: 3, write: () => undefined,
      });
      for (let index = 0; index < 20; index += 1) {
        diagnostics.emit("joi.outbox.delivery_completed", {
          attemptCount: index, durationMs: index, kind: "partner.dispatch", outboxId: `outbox_${String(index)}`,
        });
      }
      const files = (await readdir(root)).filter((name) => name.startsWith("joi-flow"));
      expect(files.length).toBeGreaterThan(1);
      expect(files.length).toBeLessThanOrEqual(3);
      const before = (await Promise.all(files.map((name) => readFile(path.join(root, name), "utf8")))).join("");
      (diagnostics as unknown as { emit(event: string, fields: Record<string, unknown>): void }).emit(
        "joi.outbox.claimed", { body: "PRIVATE", limit: 1, recordCount: 1 },
      );
      const after = (await Promise.all(files.map((name) => readFile(path.join(root, name), "utf8")))).join("");
      expect(after).toBe(before);
      expect(after).not.toContain("PRIVATE");
      for (const line of after.trim().split("\n")) expect(() => { JSON.parse(line) as unknown; }).not.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("writes one parseable safe JSON line without message content", () => {
    const lines: string[] = [];
    const diagnostics = new JsonLineRuntimeDiagnostics({
      clock: new TestClock(),
      write: (line) => { lines.push(line); },
    });

    diagnostics.emit("joi.tool.finished", {
      workbenchId: "workbench_1",
      durationMs: 12,
      inputId: "input_1",
      isError: false,
      sourceId: "source_1",
      toolCallId: "tool_1",
      toolName: "work_dispatch",
      turnId: "turn_1",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      at: "2026-07-15T12:00:00.000Z",
      workbenchId: "workbench_1",
      durationMs: 12,
      event: "joi.tool.finished",
      inputId: "input_1",
      isError: false,
      scope: "joi-flow",
      sourceId: "source_1",
      toolCallId: "tool_1",
      toolName: "work_dispatch",
      turnId: "turn_1",
    });
    expect(lines[0]).not.toContain("prompt");
    expect(lines[0]).not.toContain("body");
  });

  it("never lets a logging sink failure change product behavior", () => {
    const diagnostics = new JsonLineRuntimeDiagnostics({
      clock: new TestClock(),
      write: () => { throw new Error("sink unavailable"); },
    });

    expect(() => diagnostics.emit("joi.outbox.claimed", { limit: 20, recordCount: 0 })).not.toThrow();
    expect(() => emitRuntimeDiagnostic(undefined, "joi.outbox.claimed", { limit: 20, recordCount: 0 })).not.toThrow();
    expect(() => emitRuntimeDiagnostic(
      { emit: () => { throw new Error("sink unavailable"); } },
      "joi.outbox.claimed",
      { limit: 20, recordCount: 0 },
    )).not.toThrow();
  });

  it("disables the process stderr sink after an asynchronous broken pipe", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementationOnce(() => {
      queueMicrotask(() => process.stderr.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" })));
      return true;
    });
    try {
      const diagnostics = new JsonLineRuntimeDiagnostics({ clock: new TestClock() });
      expect(() => diagnostics.emit("joi.outbox.claimed", { limit: 1, recordCount: 0 })).not.toThrow();
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      expect(() => diagnostics.emit("joi.outbox.claimed", { limit: 1, recordCount: 0 })).not.toThrow();
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      write.mockRestore();
    }
  });

  it("reduces errors to bounded machine identifiers without logging messages", () => {
    expect(runtimeDiagnosticErrorCode({ code: "joi_turn_outcome_uncommitted" })).toBe("joi_turn_outcome_uncommitted");
    expect(runtimeDiagnosticErrorCode(Object.assign(new Error("safe summary"), { code: "unsafe_reasoning_tool" }))).toBe("unsafe_reasoning_tool");
    expect(runtimeDiagnosticErrorCode(new Error("PRIVATE MESSAGE"))).toBe("Error");
    expect(runtimeDiagnosticErrorCode(null)).toBe("unknown_error");
    expect(runtimeDiagnosticErrorCode({ code: "private value with spaces" })).toBe("unknown_error");
  });

  it("prefers a carried partner-run reason code over a generic code or name", () => {
    const carried = { partnerRunFailure: { reasonCode: "partner_run_timed_out" } };
    expect(runtimeDiagnosticErrorCode(carried)).toBe("partner_run_timed_out");
    // The carrier wins even when a code property or Error name is also present.
    expect(runtimeDiagnosticErrorCode(Object.assign(new Error("boom"), { code: "ETIMEDOUT", partnerRunFailure: { reasonCode: "workspace_lease_lost" } })))
      .toBe("workspace_lease_lost");
    // An unusable carrier falls back to the code property, then the name.
    expect(runtimeDiagnosticErrorCode({ partnerRunFailure: { reasonCode: "has spaces" } })).toBe("unknown_error");
    expect(runtimeDiagnosticErrorCode({ partnerRunFailure: {} })).toBe("unknown_error");
  });

  it("keeps only bounded explicit diagnostic detail", () => {
    expect(runtimeDiagnosticErrorDetail(null)).toBeUndefined();
    expect(runtimeDiagnosticErrorDetail(new Error("private message only"))).toBeUndefined();
    expect(runtimeDiagnosticErrorDetail({ detail: 42 })).toBeUndefined();
    expect(runtimeDiagnosticErrorDetail({ detail: "   " })).toBeUndefined();
    expect(runtimeDiagnosticErrorDetail({ detail: `  ${"x".repeat(300)}  ` })).toBe("x".repeat(240));
  });
});
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
