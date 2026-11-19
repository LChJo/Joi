/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { StartReasoningTurnInput } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import type { JoiCoordinatorStore } from "../../src/main/application/ports/joi-coordinator.js";
import type { SourceFailureKind } from "../../src/main/domain/model-sources/model-source.js";
import { DomainError } from "../../src/main/domain/errors.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const workbench = createWorkbench({ workbenchId: "workbench", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory", name: "Evidence",
  personaRevisionId: "persona", personaSummary: "Careful", project: { label: "Test" }, scopeSummary: "Test", taskContext: { activeWorkIds: [], summary: "" } });
const invalid = () => new DomainError("goal_synthesis_reference_invalid", "Unknown evidence.");

function setup(options: { repeated?: boolean; externalEffect?: boolean; sourceFailure?: SourceFailureKind; fallback?: boolean; longAnswer?: string;
  coverageExhausted?: "continue" | "no-decision"; priorTool?: string; exhaustedReason?: string; completionError?: Error } = {}) {
  const validate = options.fallback || options.coverageExhausted !== undefined ? vi.fn().mockResolvedValue(undefined)
    : options.repeated ? vi.fn().mockRejectedValue(invalid()) : vi.fn().mockRejectedValueOnce(invalid()).mockResolvedValue(undefined);
  const complete = vi.fn(async () => {
    if (options.completionError !== undefined) throw options.completionError;
  });
  const failed = vi.fn(async () => undefined);
  const emit = vi.fn();
  const progress = vi.fn<NonNullable<JoiCoordinatorStore["recordTurnProgress"]>>(async () => undefined);
  let calls = 0;
  const startTurn = vi.fn(async (turn: StartReasoningTurnInput) => {
    calls++;
    if (options.sourceFailure !== undefined && (!options.fallback || calls === 1)) {
      turn.onEvent?.({ type: "text_delta", turnId: turn.turnId, delta: "Uncommitted partial draft." });
      throw new Error("PRIVATE_PROVIDER_DETAIL");
    }
    if (calls > 3) throw new Error("Unbounded validation correction");
    if (options.externalEffect) {
      turn.onEvent?.({ type: "tool_started", turnId: turn.turnId, toolCallId: "external", toolName: "work_supplement" });
      turn.onEvent?.({ type: "tool_finished", turnId: turn.turnId, toolCallId: "external", toolName: "work_supplement", isError: false });
    }
    if (options.coverageExhausted !== undefined) {
      if (calls === 1) {
        if (options.priorTool !== undefined) {
          turn.onEvent?.({ type: "tool_started", turnId: turn.turnId, toolCallId: "prior", toolName: options.priorTool });
          turn.onEvent?.({ type: "tool_finished", turnId: turn.turnId, toolCallId: "prior", toolName: options.priorTool, isError: false });
        }
        turn.onEvent?.({ type: "tool_finished", turnId: turn.turnId, toolCallId: "failed-coverage", toolName: "turn_complete",
          isError: true, reasonCode: options.exhaustedReason ?? "goal_synthesis_coverage_incomplete", synthesisCorrectionExhausted: true,
          ...(options.exhaustedReason === undefined ? { synthesisCoverageExhausted: true } : {}) });
        turn.onEvent?.({ type: "text_delta", turnId: turn.turnId, delta: "Unverified all-done assertion." });
      } else if (options.coverageExhausted === "continue") {
        turn.onEvent?.({ type: "tool_finished", turnId: turn.turnId, toolCallId: "partial", toolName: "turn_complete",
          isError: false, outcome: "RESULT_CONTINUE" });
        turn.onEvent?.({ type: "text_delta", turnId: turn.turnId, delta: "The report is confirmed. Check the appendix next." });
      } else {
        turn.onEvent?.({ type: "text_delta", turnId: turn.turnId, delta: "Uncommitted plain text." });
      }
      return;
    }
    turn.onEvent?.({ type: "tool_started", turnId: turn.turnId, toolCallId: `complete-${String(calls)}`, toolName: "turn_complete" });
    turn.onEvent?.({ type: "tool_finished", turnId: turn.turnId, toolCallId: `complete-${String(calls)}`, toolName: "turn_complete", isError: false, outcome: "RESULT_SYNTHESIZED",
      synthesisState: { version: 1, claims: [{ statement: "PRIVATE_CLAIM", requirementIds: [], resultIds: [calls === 1 ? "invented" : "result"] }], unresolved: [], conflicts: [] } });
    turn.onEvent?.({ type: "text_delta", turnId: turn.turnId, delta: options.longAnswer ?? (calls === 1 ? "Uncommitted draft." : "Corrected deliverable.") });
    turn.onEvent?.({ type: "turn_finished", turnId: turn.turnId });
  });
  const selectFallback = vi.fn().mockResolvedValue(options.fallback
    ? { turnId: "fallback", modelId: "other", modelRevisionId: "other", sourceId: "other", sourceRevisionId: "other" } : null);
  const coordinator = new JoiCoordinator({ clock: new TestClock(), ids: new TestIds(),
    diagnostics: { emit },
    runtime: { startTurn, abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
      rollbackTurn: async () => true, steer: () => undefined, waitForIdle: async () => undefined },
    workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] }, router: { decide: async () => ({}) },
    failureClassifier: { classify: () => options.sourceFailure ?? null },
    sources: { selectFallback, selectInitial: async turnId => ({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }) },
    store: { completeInput: complete, validateSynthesisState: validate, failTurn: failed, recordTurnProgress: progress, createTurn: async () => undefined,
      requireClarification: async () => undefined,
      loadInput: async () => ({ inputId: "joi_result_input:goal:goal:r1:q0", goalInputId: "goal", resultRevision: 1, workbenchId: "workbench", body: "Synthesize evidence", status: "PENDING" }) },
  });
  return { coordinator, startTurn, validate, complete, failed, progress, selectFallback, emit };
}

describe("synthesis validation recovery", () => {
  it("keeps the complete configured model output after correcting its evidence state", async () => {
    const longAnswer = `${"Full finding.\n".repeat(4_000)}FINAL_DELIVERABLE_END`;
    const fixture = setup({ longAnswer });
    await fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0");
    expect(fixture.complete).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ completionSummary: longAnswer }));
  });

  it("allows a ready fallback to replace an uncommitted synthesis draft", async () => {
    const fixture = setup({ sourceFailure: "server_error", fallback: true });
    await fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0");
    expect(fixture.selectFallback).toHaveBeenCalledWith(expect.objectContaining({ formalOutputStarted: false, sideEffectStarted: false }));
    expect(fixture.complete).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ completionSummary: "Corrected deliverable." }));
    expect(fixture.startTurn).toHaveBeenCalledTimes(2);
  });

  it.each(["auth", "balance", "configuration", "access", "safety_refusal"] as const)("persists a non-repeating %s source failure after fallback is unavailable", async sourceFailure => {
    const fixture = setup({ sourceFailure });
    await expect(fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0")).rejects.toMatchObject({ code: `source_${sourceFailure}` });
    expect(fixture.failed).toHaveBeenCalledWith(expect.any(String), expect.any(String), { reasonCode: `source_${sourceFailure}` });
    expect(fixture.startTurn).toHaveBeenCalledOnce();
  });

  it("corrects invalid private references within the same turn before committing once", async () => {
    const fixture = setup();
    await fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0");
    expect(fixture.startTurn).toHaveBeenCalledTimes(2);
    expect(fixture.validate).toHaveBeenCalledTimes(2);
    expect(fixture.startTurn.mock.calls[1]?.[0].prompt).toContain("work_read_evidence");
    expect(fixture.complete).toHaveBeenCalledOnce();
    expect(fixture.complete).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ completionSummary: "Corrected deliverable.", synthesisState: { version: 1, claims: [{ statement: "PRIVATE_CLAIM", requirementIds: [], resultIds: ["result"] }], unresolved: [], conflicts: [] } }));
    expect(fixture.failed).not.toHaveBeenCalled();
    expect(fixture.progress.mock.calls.every(([, update]) => !update.sideEffectStarted)).toBe(true);
  });

  it("bounds repeated invalid references and never publishes the rejected draft", async () => {
    const fixture = setup({ repeated: true });
    await expect(fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0")).rejects.toMatchObject({ code: "goal_synthesis_reference_invalid" });
    expect(fixture.startTurn).toHaveBeenCalledTimes(2);
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.failed).toHaveBeenCalledOnce();
  });

  it.each(["joi_read_skill", "workbench_read_history", "goal_update_requirements"])("persists a safe continuation after coverage exhaustion following %s", async priorTool => {
    const fixture = setup({ coverageExhausted: "continue", priorTool });
    await fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0");
    expect(fixture.startTurn).toHaveBeenCalledTimes(2);
    expect(fixture.startTurn.mock.calls[1]?.[0]).toMatchObject({ repair: "synthesis-disposition" });
    expect(fixture.complete).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.any(String), {
      outcome: "RESULT_CONTINUE", completionSummary: "The report is confirmed. Check the appendix next.",
    });
    expect(fixture.failed).not.toHaveBeenCalled();
  });

  it("records a failed outcome write without adding SQLite error text to diagnostics", async () => {
    const error = Object.assign(new Error("PRIVATE_SQLITE_DETAIL"), { code: "ERR_SQLITE_ERROR", errcode: 1 });
    const fixture = setup({ completionError: error });
    await expect(fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0")).rejects.toBe(error);
    expect(fixture.emit).toHaveBeenCalledWith("joi.turn.failed",
      expect.objectContaining({ errorCode: "ERR_SQLITE_ERROR", failureStage: "persist_outcome", sqliteCode: 1 }));
    expect(JSON.stringify(fixture.emit.mock.calls)).not.toContain("PRIVATE_SQLITE_DETAIL");
  });

  it("records a blocked result without publishing an unverified answer when the disposition pass gives no decision", async () => {
    const fixture = setup({ coverageExhausted: "no-decision" });
    await fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0");
    expect(fixture.startTurn).toHaveBeenCalledTimes(2);
    expect(fixture.complete).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.any(String),
      expect.objectContaining({ outcome: "RESULT_BLOCKED" }));
    expect(JSON.stringify(fixture.complete.mock.calls)).not.toMatch(/Unverified all-done|Uncommitted plain/);
    expect(fixture.failed).not.toHaveBeenCalled();
  });

  it("does not open another pass on coverage failure after a possible Work mutation", async () => {
    const fixture = setup({ coverageExhausted: "continue", externalEffect: true });
    await expect(fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0"))
      .rejects.toMatchObject({ code: "goal_synthesis_coverage_incomplete" });
    expect(fixture.startTurn).toHaveBeenCalledOnce();
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it.each(["goal_synthesis_reference_invalid", "goal_synthesis_state_invalid"])("persists %s when the read-only recovery cannot submit a report", async exhaustedReason => {
    const fixture = setup({ coverageExhausted: "no-decision", exhaustedReason });
    await expect(fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0")).rejects.toMatchObject({ code: exhaustedReason });
    expect(fixture.startTurn).toHaveBeenCalledTimes(2);
    expect(fixture.startTurn.mock.calls[1]?.[0].repair).toBe("synthesis-disposition");
    expect(fixture.failed).toHaveBeenCalledExactlyOnceWith(expect.any(String), expect.any(String), { reasonCode: exhaustedReason });
    expect(fixture.complete).not.toHaveBeenCalled();
  });

  it("does not replay an execution-bearing synthesis while correcting its state", async () => {
    const fixture = setup({ externalEffect: true });
    await expect(fixture.coordinator.handle("joi_result_input:goal:goal:r1:q0")).rejects.toMatchObject({ code: "goal_synthesis_reference_invalid" });
    expect(fixture.startTurn).toHaveBeenCalledOnce();
    expect(fixture.complete).not.toHaveBeenCalled();
    expect(fixture.progress.mock.calls.some(([, update]) => update.sideEffectStarted)).toBe(true);
  });
});
