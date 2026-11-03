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
  function makeCoordinator(options: { failureCode: string; toolError?: boolean; toolName?: string; replaySafeRejection?: true;
    calls?: { name: string; id?: string; started?: boolean; finished?: boolean; safe?: true }[] }) {
    const rollbacks: string[] = [];
    const failTurn = vi.fn(async () => undefined);
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
            turn.onEvent?.({ isError: options.toolError ?? false, toolCallId: "call_1", toolName: options.toolName, turnId: turn.turnId, type: "tool_finished",
              ...(options.replaySafeRejection === undefined ? {} : { replaySafeRejection: options.replaySafeRejection }) });
          }
          for (const [index, call] of (options.calls ?? []).entries()) {
            const shared = { toolCallId: call.id ?? `extra-${String(index)}`, toolName: call.name, turnId: turn.turnId };
            if (call.started !== false) turn.onEvent?.({ ...shared, type: "tool_started" });
            if (call.finished !== false) turn.onEvent?.({ ...shared, type: "tool_finished", isError: true,
              ...(call.safe === undefined ? {} : { replaySafeRejection: call.safe }) });
          }
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => { throw Object.assign(new Error(options.failureCode), { code: options.failureCode }); },
        createTurn: async () => undefined,
        failTurn,
        loadInput: async () => ({ body: "研究", inputId: "input", status: "PENDING", workbenchId: "workbench" }),
        requireClarification: async () => undefined,
      },
    });
    return { coordinator, rollbacks, failTurn };
  }

  it("rolls a failed Turn back when its input will be re-queued", async () => {
    const { coordinator, rollbacks } = makeCoordinator({ failureCode: "goal_resume_required" });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "goal_resume_required" });
    expect(rollbacks).toHaveLength(1);
  });

  it("keeps the transcript of a Turn that committed a side effect", async () => {
    // `work_dispatch` is not replay-safe, so this input is consumed rather than re-queued. Rolling
    // back would erase the only account of work that is now dispatched and still running. The
    // Turn still reaches completeInput (here rejected by the fixture), not the uncommitted-outcome
    // path, because a successful work_dispatch is itself a committed outcome.
    const { coordinator, rollbacks } = makeCoordinator({ failureCode: "unused", toolName: "work_dispatch" });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "unused" });
    expect(rollbacks).toEqual([]);
  });

  it("keeps the transcript of a read-only Turn that failed", async () => {
    // The counterpart to the case above: a lookup leaves nothing to duplicate, and the input is
    // re-queued, so the failed attempt comes back out.
    const { coordinator, rollbacks } = makeCoordinator({ failureCode: "unused", toolName: "partner_list_available" });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "joi_turn_outcome_uncommitted" });
    expect(rollbacks).toHaveLength(1);
  });

  it("keeps a dispatch failure whose commit state is unproven", async () => {
    const { coordinator, rollbacks } = makeCoordinator({ failureCode: "unused", toolError: true, toolName: "work_dispatch" });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "tool_execution_error" });
    expect(rollbacks).toEqual([]);
  });

  it("rolls back a dispatch rejected with trusted proof of no submission", async () => {
    const { coordinator, rollbacks } = makeCoordinator({ failureCode: "unused", toolError: true, toolName: "work_dispatch", replaySafeRejection: true });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "tool_execution_error" });
    expect(rollbacks).toHaveLength(1);
  });

  it("does not treat a nonterminal dispatch correction as a committed outcome", async () => {
    const { coordinator, rollbacks, failTurn } = makeCoordinator({ failureCode: "unused", toolName: "work_dispatch", replaySafeRejection: true });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "joi_turn_outcome_uncommitted" });
    expect(rollbacks).toHaveLength(1);
    expect(failTurn).toHaveBeenCalledWith("input", expect.any(String), expect.objectContaining({ replaySafe: true }));
  });

  it("preserves explicit goal recovery semantics for a trusted goal_resume rejection", async () => {
    const { coordinator, rollbacks, failTurn } = makeCoordinator({ failureCode: "unused", toolName: "goal_resume", toolError: true, replaySafeRejection: true });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "joi_turn_outcome_uncommitted" });
    expect(rollbacks).toEqual([]);
    expect(failTurn).not.toHaveBeenCalledWith("input", expect.any(String), expect.objectContaining({ replaySafe: true }));
  });

  it("keeps the transcript of a Turn whose cancel attempt errored out", async () => {
    // Cancellation can commit before a later step fails; SDK errors alone prove no replay safety.
    const { coordinator, rollbacks } = makeCoordinator({ failureCode: "unused", toolError: true, toolName: "work_cancel" });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "joi_turn_outcome_uncommitted" });
    expect(rollbacks).toEqual([]);
  });

  it.each([
    { calls: [{ name: "work_dispatch", safe: true as const }, { name: "work_cancel" }] },
    { calls: [{ name: "work_dispatch", safe: true as const }, { name: "work_dispatch", finished: false }] },
    { calls: [{ name: "work_dispatch", id: "duplicate" }, { name: "work_dispatch", id: "duplicate", safe: true as const }] },
    { calls: [{ name: "work_dispatch", safe: true as const, started: false }] },
  ])("retains protection for mixed or unmatched calls: %j", async ({ calls }) => {
    const { coordinator, rollbacks, failTurn } = makeCoordinator({ failureCode: "unused", calls });
    await expect(coordinator.handle("input")).rejects.toMatchObject({ code: "tool_execution_error" });
    expect(rollbacks).toEqual([]);
    expect(failTurn).not.toHaveBeenCalledWith("input", expect.any(String), expect.objectContaining({ replaySafe: true }));
  });
});
