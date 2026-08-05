import { JsonLineRuntimeDiagnostics } from "../../src/main/infrastructure/runtime/json-line-runtime-diagnostics.js";
import {
  emitRuntimeDiagnostic,
  runtimeDiagnosticErrorCode,
} from "../../src/main/application/ports/runtime-diagnostics.js";
import { TestClock } from "../support/runtime-fixture.js";

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
      avatarId: "avatar_1",
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
      avatarId: "avatar_1",
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

  it("reduces errors to bounded machine identifiers without logging messages", () => {
    expect(runtimeDiagnosticErrorCode({ code: "joi_turn_outcome_uncommitted" })).toBe("joi_turn_outcome_uncommitted");
    expect(runtimeDiagnosticErrorCode(new Error("PRIVATE MESSAGE"))).toBe("Error");
    expect(runtimeDiagnosticErrorCode(null)).toBe("unknown_error");
    expect(runtimeDiagnosticErrorCode({ code: "private value with spaces" })).toBe("unknown_error");
  });
});
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
