/* Test doubles implement asynchronous port contracts. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const reviewInputId = "joi_harness_review:goal:goal:r1:q1";
const workbench = createWorkbench({
  workbenchId: "workbench", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory", name: "Code",
  personaRevisionId: "persona", personaSummary: "Careful", project: { label: "Repo" }, scopeSummary: "Code",
  taskContext: { activeWorkIds: [], summary: "" },
});

function fixture(tools: { name: string; finished?: boolean; isError?: boolean; replaySafeRejection?: true }[]) {
  const failTurn = vi.fn(async () => undefined);
  let pass = 0;
  const coordinator = new JoiCoordinator({
    workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
    clock: new TestClock(), ids: new TestIds(),
    router: { decide: async () => ({ action: "select" as const, workbenchId: "workbench" }) },
    runtime: {
      abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
      rollbackTurn: async () => true, steer: () => undefined, waitForIdle: async () => undefined,
      startTurn: async turn => {
        if (pass++ === 0) for (const [index, tool] of tools.entries()) {
          const shared = { toolCallId: `call-${String(index)}`, toolName: tool.name, turnId: turn.turnId };
          turn.onEvent?.({ ...shared, type: "tool_started" });
          if (tool.finished !== false) {
            const event = { ...shared, type: "tool_finished" as const, isError: tool.isError ?? false,
              ...(tool.replaySafeRejection === undefined ? {} : { replaySafeRejection: tool.replaySafeRejection }) };
            turn.onEvent?.(event);
          }
        }
      },
    },
    sources: { selectInitial: async turnId => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
    store: {
      completeInput: async () => { throw new Error("commit_failed"); }, createTurn: async () => undefined,
      loadInput: async () => ({ body: "Review current evidence", goalInputId: "goal", inputId: reviewInputId, status: "PENDING", workbenchId: "workbench" }),
      requireClarification: async () => undefined, failTurn,
    },
  });
  return { coordinator, failTurn };
}

describe("settled review replay safety", () => {
  it.each(["partner_list_available", "harness_record_decision", "harness_note_fog"])(
    "permits a bounded fresh review after the settled internal tool %s", async name => {
      const { coordinator, failTurn } = fixture([{ name }]);
      await expect(coordinator.handle(reviewInputId)).rejects.toMatchObject({ code: "joi_turn_outcome_uncommitted" });
      expect(failTurn).toHaveBeenCalledWith(reviewInputId, expect.any(String), {
        reasonCode: "joi_turn_outcome_uncommitted", reviewReplaySafe: true,
      });
    },
  );

  it.each(["goal_resume", "harness_record_decision", "work_dispatch"])("accepts a trusted no-effect %s rejection without treating it as an external mutation", async name => {
    const { coordinator, failTurn } = fixture([{ name, isError: true, replaySafeRejection: true }]);
    const reasonCode = name === "work_dispatch" ? "tool_execution_error" : "joi_turn_outcome_uncommitted";
    await expect(coordinator.handle(reviewInputId)).rejects.toMatchObject({ code: reasonCode });
    expect(failTurn).toHaveBeenCalledWith(reviewInputId, expect.any(String), {
      reasonCode, reviewReplaySafe: true,
      ...(name === "work_dispatch" ? { replaySafe: true } : {}),
    });
  });

  it("preserves external dispatch uncertainty when final persistence fails", async () => {
    const { coordinator, failTurn } = fixture([{ name: "work_dispatch" }]);
    await expect(coordinator.handle(reviewInputId)).rejects.toThrow("commit_failed");
    expect(failTurn).toHaveBeenCalledWith(reviewInputId, expect.any(String), expect.objectContaining({ reviewReplaySafe: false }));
  });

  it.each([
    { tools: [{ name: "harness_record_decision", isError: true }] },
    { tools: [{ name: "goal_resume", isError: true }] },
    { tools: [{ name: "goal_resume", finished: false }] },
    { tools: [{ name: "memory_append_candidate" }, { name: "goal_resume", isError: true, replaySafeRejection: true as const }] },
  ])("retains uncertainty for unproven or unfinished mutations: %j", async ({ tools }) => {
    const { coordinator, failTurn } = fixture(tools);
    await expect(coordinator.handle(reviewInputId)).rejects.toMatchObject({ code: "joi_turn_outcome_uncommitted" });
    expect(failTurn).toHaveBeenCalledWith(reviewInputId, expect.any(String), {
      reasonCode: "joi_turn_outcome_uncommitted", reviewReplaySafe: false,
    });
  });

  it.each([
    { tools: [{ name: "work_dispatch" }, { name: "harness_record_decision", isError: true, replaySafeRejection: true as const }] },
    { tools: [{ name: "harness_record_decision", finished: false }, { name: "work_dispatch", isError: true, replaySafeRejection: true as const }] },
  ])("does not let a rejected call erase other unfinished or external effects: %j", async ({ tools }) => {
    const { coordinator, failTurn } = fixture(tools);
    await expect(coordinator.handle(reviewInputId)).rejects.toThrow();
    expect(failTurn).toHaveBeenCalledWith(reviewInputId, expect.any(String), expect.objectContaining({ reviewReplaySafe: false }));
  });
});
