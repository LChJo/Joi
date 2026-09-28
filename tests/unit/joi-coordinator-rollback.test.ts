/* Test doubles resolve synchronously through Promise contracts. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const workbench = createWorkbench({
  workbenchId: "workbench", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory", name: "Code",
  personaRevisionId: "persona", personaSummary: "Careful", project: { label: "Repo" }, scopeSummary: "Code",
  taskContext: { activeWorkIds: [], summary: "" },
});

/**
 * Whether a failed Turn's transcript is taken back out of its session decides what the retry
 * inherits. The distinction the coordinator has to make is the same one `failTurn` makes to
 * decide if the input is re-queued at all: a Turn that committed a side effect is consumed and
 * never replayed, so its transcript is the only record of what it already dispatched.
 */
describe("joi coordinator session rollback", () => {
  function makeCoordinator(options: { failureCode: string; toolName?: string }) {
    const rollbacks: string[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => ({ action: "select" as const, workbenchId: "workbench" }) },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
        rollbackTurn: async (_sessionId, turnId) => { rollbacks.push(turnId); return true; },
        startTurn: async (turn) => {
          turn.onEvent?.({ delta: "处理完成", turnId: turn.turnId, type: "text_delta" });
          if (options.toolName !== undefined) {
            turn.onEvent?.({ toolCallId: "call_1", toolName: options.toolName, turnId: turn.turnId, type: "tool_started" });
          }
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => { throw Object.assign(new Error(options.failureCode), { code: options.failureCode }); },
        createTurn: async () => undefined,
        loadInput: async () => ({ body: "研究", inputId: "input", status: "PENDING", workbenchId: "workbench" }),
        requireClarification: async () => undefined,
      },
    });
    return { coordinator, rollbacks };
  }

  it("rolls a failed Turn back when its input will be re-queued", async () => {
    const { coordinator, rollbacks } = makeCoordinator({ failureCode: "goal_resume_required" });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "goal_resume_required" });
    expect(rollbacks).toHaveLength(1);
  });

  it("keeps the transcript of a Turn that committed a side effect", async () => {
    // `work_dispatch` is not replay-safe, so this input is consumed rather than re-queued. Rolling
    // back would erase the only account of work that is now dispatched and still running.
    const { coordinator, rollbacks } = makeCoordinator({ failureCode: "unused", toolName: "work_dispatch" });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "joi_turn_outcome_uncommitted" });
    expect(rollbacks).toEqual([]);
  });

  it("keeps the transcript of a read-only Turn that failed", async () => {
    // The counterpart to the case above: a lookup leaves nothing to duplicate, and the input is
    // re-queued, so the failed attempt comes back out.
    const { coordinator, rollbacks } = makeCoordinator({ failureCode: "unused", toolName: "partner_list_available" });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "joi_turn_outcome_uncommitted" });
    expect(rollbacks).toHaveLength(1);
  });
});
