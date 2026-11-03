/* Test doubles resolve synchronously through Promise contracts. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { PrimaryReasoningRuntime, StartReasoningTurnInput } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const workbench = createWorkbench({ workbenchId: "workbench", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory", name: "Evidence",
  personaRevisionId: "persona", personaSummary: "Careful", project: { label: "Test" }, scopeSummary: "Test", taskContext: { activeWorkIds: [], summary: "" } });

describe("synthesis outcome repair", () => {
  it("isolates seven result versions and requirement changes while restoring the same version identity after restart", async () => {
    const turns: StartReasoningTurnInput[] = [];
    const versions = [...Array.from({ length: 7 }, (_, index) => ({ r: index + 1, q: 1 })), { r: 7, q: 2 }, { r: 7, q: 2 }];
    for (const { r, q } of versions) {
      const coordinator = new JoiCoordinator({ clock: new TestClock(), ids: new TestIds(),
        runtime: { startTurn: async turn => {
          turns.push(turn);
          turn.onEvent?.({ type: "text_delta", turnId: turn.turnId, delta: "[joi synthesis outcome=RESULT_SYNTHESIZED]\nComplete deliverable." });
        }, abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
        rollbackTurn: async () => false, steer: () => undefined, waitForIdle: async () => undefined },
        workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] }, router: { decide: async () => ({}) },
        sources: { selectInitial: async turnId => ({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }) },
        store: { completeInput: async () => undefined, createTurn: async () => undefined, requireClarification: async () => undefined,
          loadInput: async () => ({ inputId: "synthesis", goalInputId: "goal", resultRevision: r, requirementsRevision: q, workbenchId: "workbench", body: "Synthesize this version", status: "PENDING",
            synthesisContext: { originalRequest: "MANDATORY_REQUIREMENT", resultRevision: r, requirementsRevision: q, changedResults: [], totalResults: 163, gapCount: 0, omittedChanges: 0,
              previous: { resultRevision: r - 1, disposition: "CONTINUE", summary: "PRIVATE_PREVIOUS_CONCLUSION" } } }) },
      });
      await coordinator.handle("synthesis");
    }
    expect(new Set(turns.map(turn => turn.sessionId)).size).toBe(8);
    expect(turns.at(-1)?.sessionId).toBe(turns.at(-2)?.sessionId);
    for (const turn of turns) {
      expect(turn.prompt).not.toContain("PRIVATE_PREVIOUS_CONCLUSION");
      expect(turn.backgroundContext).toContain("PRIVATE_PREVIOUS_CONCLUSION");
      expect(turn.requiredContext).toBe("MANDATORY_REQUIREMENT");
      expect(turn.sessionId).toMatch(/^joi_synthesis_snapshot_v1:/u);
    }
  });
  it.each(["RESULT_SYNTHESIZED", "RESULT_CONTINUE", "RESULT_BLOCKED"] as const)("accepts an explicit text %s decision on the first response without another model call", async outcome => {
    const completeInput = vi.fn(async () => undefined);
    const startTurn = vi.fn(async (turn: StartReasoningTurnInput) => {
      turn.onEvent?.({ type: "text_delta", turnId: turn.turnId, delta: `[joi synthesis outcome=${outcome}]\nExisting evidence answers the request.` });
      turn.onEvent?.({ type: "turn_finished", turnId: turn.turnId });
    });
    const coordinator = new JoiCoordinator({ clock: new TestClock(), ids: new TestIds(),
      runtime: { startTurn, abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
        rollbackTurn: async () => false, steer: () => undefined, waitForIdle: async () => undefined },
      workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] }, router: { decide: async () => ({}) },
      sources: { selectInitial: async turnId => ({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake", modelCapability: "custom-unverified-tools", toolCapabilityProven: false }) },
      store: { completeInput, createTurn: async () => undefined, requireClarification: async () => undefined,
        loadInput: async () => ({ inputId: "synthesis", goalInputId: "goal", resultRevision: 1, workbenchId: "workbench", body: "Synthesize evidence", status: "PENDING" }) },
    });
    await coordinator.handle("synthesis");
    expect(startTurn).toHaveBeenCalledOnce();
    expect(completeInput).toHaveBeenCalledWith("synthesis", expect.any(String), { outcome, completionSummary: "Existing evidence answers the request." });
  });

  it.each(["RESULT_SYNTHESIZED", "RESULT_CONTINUE", "RESULT_BLOCKED"] as const)("repairs a tool-less synthesis into a real %s outcome without dispatching work", async outcome => {
    const turns: StartReasoningTurnInput[] = [];
    const completeInput = vi.fn(async () => undefined);
    const runtime: PrimaryReasoningRuntime = {
      abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
      rollbackTurn: async () => false, steer: () => undefined, waitForIdle: async () => undefined,
      startTurn: async turn => {
        turns.push(turn);
        if (turns.length === 2) {
          expect(turn.prompt).toContain("goal-result synthesis");
          expect(turn.prompt).toContain("real tool-call mechanism");
          expect(turn.prompt).toContain("RESULT_SYNTHESIZED");
          expect(turn.prompt).toContain("RESULT_CONTINUE");
          expect(turn.prompt).toContain("RESULT_BLOCKED");
          expect(turn.prompt).not.toContain("preceding response used tools");
          expect(turn.prompt).not.toContain("call work_dispatch");
          turn.onEvent?.({ type: "tool_started", turnId: turn.turnId, toolCallId: "commit", toolName: "turn_complete" });
          turn.onEvent?.({ type: "tool_finished", turnId: turn.turnId, toolCallId: "commit", toolName: "turn_complete", isError: false, outcome });
        }
        turn.onEvent?.({ type: "text_delta", turnId: turn.turnId, delta: "Evidence and remaining coverage." });
        turn.onEvent?.({ type: "turn_finished", turnId: turn.turnId });
      },
    };
    const coordinator = new JoiCoordinator({ runtime, clock: new TestClock(), ids: new TestIds(),
      workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
      router: { decide: async () => { throw new Error("Already bound"); } },
      sources: { selectInitial: async turnId => ({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }) },
      store: { completeInput, createTurn: async () => undefined, requireClarification: async () => undefined,
        loadInput: async () => ({ inputId: "synthesis", goalInputId: "goal", resultRevision: 1, workbenchId: "workbench", body: "Synthesize evidence", status: "PENDING" }) },
    });
    await coordinator.handle("synthesis");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.sessionId).toBe(turns[0]?.sessionId);
    expect(completeInput).toHaveBeenCalledWith("synthesis", expect.any(String), expect.objectContaining({ outcome }));
  });

  it.each([
    ["plain outcome name", "turn_complete RESULT_SYNTHESIZED", "joi_turn_outcome_uncommitted"],
    ["missing body", "[joi synthesis outcome=RESULT_SYNTHESIZED]\n", "joi_turn_outcome_uncommitted"],
    ["quoted decision", "Quoted example: [joi synthesis outcome=RESULT_SYNTHESIZED]\nText", "joi_turn_outcome_uncommitted"],
    ["invalid outcome", "[joi synthesis outcome=COMPLETED]\nText", "joi_turn_outcome_uncommitted"],
    ["leaked tool markup", "[joi synthesis outcome=RESULT_SYNTHESIZED]\n<|DSML|invoke name=turn_complete>", "joi_model_toolcall_leak"],
  ])("rejects %s instead of inferring success", async (_scenario, text, code) => {
    const completeInput = vi.fn(async () => undefined);
    const startTurn = vi.fn(async (turn: StartReasoningTurnInput) => {
      turn.onEvent?.({ type: "text_delta", turnId: turn.turnId, delta: text });
      turn.onEvent?.({ type: "turn_finished", turnId: turn.turnId });
    });
    const coordinator = new JoiCoordinator({ clock: new TestClock(), ids: new TestIds(),
      runtime: { startTurn, abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
        rollbackTurn: async () => false, steer: () => undefined, waitForIdle: async () => undefined },
      workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] }, router: { decide: async () => ({}) },
      sources: { selectInitial: async turnId => ({ turnId, modelId: "fake", modelRevisionId: "fake", sourceId: "fake", sourceRevisionId: "fake" }) },
      store: { completeInput, createTurn: async () => undefined, requireClarification: async () => undefined,
        loadInput: async () => ({ inputId: "synthesis", goalInputId: "goal", resultRevision: 1, workbenchId: "workbench", body: "Synthesize evidence", status: "PENDING" }) },
    });
    await expect(coordinator.handle("synthesis")).rejects.toMatchObject({ code });
    expect(startTurn).toHaveBeenCalledTimes(2);
    expect(completeInput).not.toHaveBeenCalled();
  });
});
