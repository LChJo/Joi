/* Orchestration test doubles resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { JoiCoordinatorStore } from "../../src/main/application/ports/joi-coordinator.js";
import type { PrimaryReasoningRuntime, StartReasoningTurnInput } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const research = createWorkbench({
  workbenchId: "research", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory-research", name: "研究",
  personaRevisionId: "persona-r", personaSummary: "RESEARCH_SECRET_SENTINEL", project: { label: "研究工程" }, scopeSummary: "技术研究", taskContext: { activeWorkIds: [], summary: "" },
});
const finance = createWorkbench({
  workbenchId: "finance", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory-finance", name: "财务",
  personaRevisionId: "persona-f", personaSummary: "FINANCE_SECRET_SENTINEL", project: { label: "财务工程" }, scopeSummary: "财务事务", taskContext: { activeWorkIds: [], summary: "" },
});

describe("single-joi-workbench-scoped-thread-isolation", () => {
  it("resumes a resolved partner action deterministically without asking the model to rediscover the Work", async () => {
    const resumed: unknown[] = [];
    const completedActions: unknown[] = [];
    let reasoningStarts = 0;
    let sourceSelections = 0;
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("bound input must not route"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async () => { reasoningStarts += 1; },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => { sourceSelections += 1; return { modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }; } },
      store: {
        completeInput: async () => undefined,
        completeResolvedAction: async (input) => { completedActions.push(input); },
        createTurn: async () => undefined,
        loadInput: async () => ({
          body: "原始要求\n\n[用户补充] 使用现有配置",
          inputId: "input-resume",
          resolvedAction: { actionId: "attention-run-1", decision: "RESUME", workId: "work-1" },
          status: "PENDING",
          workbenchId: "research",
        }),
        requireClarification: async () => undefined,
      },
      work: { resume: async (input) => { resumed.push(input); return {} as never; } },
    });

    await coordinator.handle("input-resume");

    expect(reasoningStarts).toBe(0);
    expect(sourceSelections).toBe(0);
    expect(resumed).toEqual([expect.objectContaining({ workbenchId: "research", workId: "work-1" })]);
    expect(completedActions).toEqual([expect.objectContaining({ actionId: "attention-run-1", inputId: "input-resume" })]);
  });

  it("persists a bounded safe completion for a no-tool direct answer", async () => {
    const completions: unknown[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("bound input must not route"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => {
          turn.onEvent?.({ delta: "## 身份\n\n我是 Joi。 token=abcdefghijklmnop C:\\private\\a\\b\\answer.md", turnId: turn.turnId, type: "text_delta" });
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async (inputId, turnId, completion) => { completions.push({ completion, inputId, turnId }); },
        createTurn: async () => undefined,
        loadInput: async () => ({ body: "你是谁", inputId: "input-direct", status: "PENDING", workbenchId: "research" }),
        requireClarification: async () => undefined,
      },
    });

    await coordinator.handle("input-direct");
    expect(completions).toEqual([expect.objectContaining({
      completion: {
        completionSummary: "## 身份\n\n我是 Joi。 token=[redacted] C:\\…\\a\\b\\answer.md",
        outcome: "DIRECT_ANSWER",
      },
      inputId: "input-direct",
    })]);
  });

  it("repairs one empty direct response before committing a visible answer", async () => {
    let starts = 0;
    const completions: unknown[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("bound input must not route"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => {
          starts += 1;
          if (starts === 2) turn.onEvent?.({ delta: "我是 Joi。", turnId: turn.turnId, type: "text_delta" });
          turn.onEvent?.({ turnId: turn.turnId, type: "turn_finished" });
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async (_inputId, _turnId, completion) => { completions.push(completion); },
        createTurn: async () => undefined,
        loadInput: async () => ({ body: "你是谁", inputId: "input-empty-direct", status: "PENDING", workbenchId: "research" }),
        requireClarification: async () => undefined,
      },
    });

    await coordinator.handle("input-empty-direct");
    expect(starts).toBe(2);
    expect(completions).toEqual([{ completionSummary: "我是 Joi。", outcome: "DIRECT_ANSWER" }]);
  });

  it("runs result synthesis in an isolated session and persists the bounded final answer for the original goal", async () => {
    const completions: unknown[] = [];
    const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
    const sessions: string[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
      router: { decide: async () => { throw new Error("synthesis input is pre-bound"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => {
          sessions.push(turn.sessionId);
          turn.onEvent?.({ delta: "两项工作已完成。 C:\\private\\a\\b\\file。", turnId: turn.turnId, type: "text_delta" });
          turn.onEvent?.({ toolCallId: "complete", toolName: "turn_complete", turnId: turn.turnId, type: "tool_started" });
          turn.onEvent?.({ isError: false, outcome: "RESULT_SYNTHESIZED", toolCallId: "complete", toolName: "turn_complete", turnId: turn.turnId, type: "tool_finished" });
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async (inputId, turnId, completion) => {
          completions.push({ completion, inputId, turnId });
          return { goalInputId: "goal-1", goalOutcomePersisted: true, resultRevision: 2 };
        },
        createTurn: async () => undefined,
        loadInput: async () => ({
          workbenchId: "research", body: "synthesize", goalInputId: "goal-1", inputId: "joi_result_input:goal:goal-1",
          resultRevision: 2, status: "PENDING",
        }),
        requireClarification: async () => undefined,
      },
    });

    await coordinator.handle("joi_result_input:goal:goal-1");
    expect(sessions).toEqual(["joi_synthesis_session:research:goal-1"]);
    expect(completions).toEqual([expect.objectContaining({
      completion: { completionSummary: "两项工作已完成。 C:\\…\\a\\b\\file。", outcome: "RESULT_SYNTHESIZED" },
      inputId: "joi_result_input:goal:goal-1",
    })]);
    expect(diagnostics.map((entry) => entry.event)).toEqual(expect.arrayContaining([
      "joi.goal.synthesis.started", "joi.goal.synthesis.completed", "joi.goal.outcome.persisted",
    ]));
  });

  it("persists an explicit blocked synthesis disposition instead of forcing every synthesis to completed", async () => {
    const completions: unknown[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("synthesis input is pre-bound"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => {
          turn.onEvent?.({ delta: "关键证据缺失，当前无法给出可靠结论。", turnId: turn.turnId, type: "text_delta" });
          turn.onEvent?.({ toolCallId: "blocked", toolName: "turn_complete", turnId: turn.turnId, type: "tool_started" });
          turn.onEvent?.({ isError: false, outcome: "RESULT_BLOCKED", toolCallId: "blocked", toolName: "turn_complete", turnId: turn.turnId, type: "tool_finished" });
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async (_inputId, _turnId, completion) => { completions.push(completion); },
        createTurn: async () => undefined,
        loadInput: async () => ({
          workbenchId: "research", body: "synthesize", goalInputId: "goal-blocked", inputId: "joi_result_input:goal:goal-blocked",
          resultRevision: 3, status: "PENDING",
        }),
        requireClarification: async () => undefined,
      },
    });

    await coordinator.handle("joi_result_input:goal:goal-blocked");
    expect(completions).toEqual([{
      completionSummary: "关键证据缺失，当前无法给出可靠结论。",
      outcome: "RESULT_BLOCKED",
    }]);
  });

  it("repairs a synthesis turn that returns text without an explicit result disposition", async () => {
    let starts = 0;
    const prompts: string[] = [];
    const completions: unknown[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("synthesis input is pre-bound"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => {
          starts += 1;
          prompts.push(turn.prompt);
          turn.onEvent?.({ delta: starts === 1 ? "未提交的总结" : "修复后的可靠总结", turnId: turn.turnId, type: "text_delta" });
          if (starts === 2) {
            turn.onEvent?.({ toolCallId: "complete", toolName: "turn_complete", turnId: turn.turnId, type: "tool_started" });
            turn.onEvent?.({ isError: false, outcome: "RESULT_SYNTHESIZED", toolCallId: "complete", toolName: "turn_complete", turnId: turn.turnId, type: "tool_finished" });
          }
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async (_inputId, _turnId, completion) => { completions.push(completion); },
        createTurn: async () => undefined,
        loadInput: async () => ({
          workbenchId: "research", body: "synthesize", goalInputId: "goal-repair", inputId: "joi_result_input:goal:goal-repair",
          resultRevision: 1, status: "PENDING",
        }),
        requireClarification: async () => undefined,
      },
    });

    await coordinator.handle("joi_result_input:goal:goal-repair");
    expect(starts).toBe(2);
    expect(prompts[1]).toContain("commit an outcome");
    expect(completions).toEqual([{ completionSummary: "修复后的可靠总结", outcome: "RESULT_SYNTHESIZED" }]);
  });

  it("fails an internal work dispatch without fabricating a user clarification", async () => {
    let starts = 0;
    const clarifications: string[] = [];
    let completions = 0;
    let failures = 0;
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("bound input must not route again"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => {
          starts += 1;
          turn.onEvent?.({ toolCallId: "dispatch", toolName: "work_dispatch", turnId: turn.turnId, type: "tool_started" });
          turn.onEvent?.({ isError: true, reasonCode: "tool_execution_error", toolCallId: "dispatch", toolName: "work_dispatch", turnId: turn.turnId, type: "tool_finished" });
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => { completions += 1; },
        createTurn: async () => undefined,
        failTurn: async () => { failures += 1; },
        loadInput: async () => ({ body: "派发任务", inputId: "input-dispatch-failed", status: "PENDING", workbenchId: "research" }),
        requireClarification: async (_inputId, reason) => { clarifications.push(reason); },
      },
    });

    await expect(coordinator.handle("input-dispatch-failed")).rejects.toMatchObject({ code: "tool_execution_error" });
    expect(starts).toBe(1);
    expect(clarifications).toEqual([]);
    expect(completions).toBe(0);
    expect(failures).toBe(1);
  });

  it("preserves a partner-selection clarification already committed by the dispatch tool", async () => {
    const clarifications: string[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("bound input must not route again"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => {
          turn.onEvent?.({ toolCallId: "dispatch", toolName: "work_dispatch", turnId: turn.turnId, type: "tool_started" });
          turn.onEvent?.({ isError: false, reasonCode: "partner_selection_required", toolCallId: "dispatch", toolName: "work_dispatch", turnId: turn.turnId, type: "tool_finished" });
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => undefined,
        createTurn: async () => undefined,
        loadInput: async () => ({ body: "派发任务", inputId: "input-partner-choice", status: "PENDING", workbenchId: "research" }),
        requireClarification: async (_inputId, reason) => { clarifications.push(reason); },
      },
    });

    await coordinator.handle("input-partner-choice");
    expect(clarifications).toEqual([]);
  });

  it("aborts a canceled turn before it can commit completion", async () => {
    const controller = new AbortController();
    let aborts = 0;
    let completions = 0;
    let failures = 0;
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("bound input must not route"); } },
      runtime: {
        abort: () => { aborts += 1; },
        followUp: () => undefined,
        isRunning: () => false,
        restore: async () => false, rollbackTurn: async () => false,
        startTurn: async () => { controller.abort(); },
        steer: () => undefined,
        waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => { completions += 1; },
        createTurn: async () => undefined,
        failTurn: async () => { failures += 1; },
        loadInput: async () => ({ body: "cancel me", inputId: "input-cancel", status: "PENDING", workbenchId: "research" }),
        requireClarification: async () => undefined,
      },
    });

    await expect(coordinator.handle("input-cancel", controller.signal)).rejects.toMatchObject({ code: "joi_turn_aborted" });
    expect(aborts).toBeGreaterThan(0);
    expect(completions).toBe(0);
    expect(failures).toBe(1);
  });

  it("rejects an already canceled input before loading it", async () => {
    const controller = new AbortController();
    controller.abort();
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => ({ action: "select", workbenchId: "research" }) },
      runtime: { abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false, startTurn: async () => undefined, steer: () => undefined, waitForIdle: async () => undefined },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: { completeInput: async () => undefined, createTurn: async () => undefined, loadInput: async () => { throw new Error("must not load"); }, requireClarification: async () => undefined },
    });

    await expect(coordinator.handle("input-canceled-before-load", controller.signal)).rejects.toMatchObject({ code: "joi_turn_aborted" });
  });

  it("cancels an input that is aborted while its source is being selected", async () => {
    const controller = new AbortController();
    let aborts = 0;
    let starts = 0;
    let failures = 0;
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => { controller.abort(); return research; }, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("bound input must not route"); } },
      runtime: {
        abort: () => { aborts += 1; }, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async () => { starts += 1; }, steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => undefined,
        createTurn: async () => undefined,
        failTurn: async () => { failures += 1; },
        loadInput: async () => ({ body: "cancel during source selection", inputId: "input-cancel-source", status: "PENDING", workbenchId: "research" }),
        requireClarification: async () => undefined,
      },
    });

    await expect(coordinator.handle("input-cancel-source", controller.signal)).rejects.toMatchObject({ code: "joi_turn_aborted" });
    expect(aborts).toBe(2);
    expect(starts).toBe(0);
    expect(failures).toBe(1);
  });

  it("does not commit when cancellation arrives at the result boundary", async () => {
    let reads = 0;
    const signal = {
      get aborted() { reads += 1; return reads >= 5; },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    } as unknown as AbortSignal;
    let completions = 0;
    let failures = 0;
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("bound input must not route"); } },
      runtime: { abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false, startTurn: async () => undefined, steer: () => undefined, waitForIdle: async () => undefined },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => { completions += 1; },
        createTurn: async () => undefined,
        failTurn: async () => { failures += 1; },
        loadInput: async () => ({ body: "cancel at result boundary", inputId: "input-cancel-result", status: "PENDING", workbenchId: "research" }),
        requireClarification: async () => undefined,
      },
    });

    await expect(coordinator.handle("input-cancel-result", signal)).rejects.toMatchObject({ code: "joi_turn_aborted" });
    expect(completions).toBe(0);
    expect(failures).toBe(1);
  });

  it("routes from summaries then gives the one global runtime only the selected Workbench body", async () => {
    const observedRouting: unknown[] = [];
    const turns: StartReasoningTurnInput[] = [];
    const statuses: string[] = [];
    const store: JoiCoordinatorStore = {
      completeInput: async () => { statuses.push("consumed"); },
      createTurn: async () => { statuses.push("turn-created"); },
      loadInput: async () => ({ body: "继续技术研究", inputId: "input-1", status: "PENDING" }),
      requireClarification: async () => { statuses.push("clarify"); },
    };
    const runtime: PrimaryReasoningRuntime = {
      abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
      startTurn: async (turn) => { turns.push(turn); }, steer: () => undefined, waitForIdle: async () => undefined,
    };
    const coordinator = new JoiCoordinator({
      workbenches: {
        getWorkbench: async (workbenchId) => workbenchId === "research" ? research : workbenchId === "finance" ? finance : null,
        listSummaries: async () => [research, finance].map((workbench) => ({ workbenchId: workbench.workbenchId, name: workbench.profile.name, scopeSummary: workbench.profile.scopeSummary, updatedAt: workbench.updatedAt })),
      },
      clock: new TestClock(), ids: new TestIds(), runtime,
      router: { decide: async (input) => { observedRouting.push(input); return { action: "select", workbenchId: "research" }; } },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store,
    });
    await coordinator.handle("input-1");
    expect(JSON.stringify(observedRouting)).not.toMatch(/RESEARCH_SECRET_SENTINEL|FINANCE_SECRET_SENTINEL/u);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.workbenchId).toBe("research");
    expect(turns[0]?.systemPrompt).toContain("RESEARCH_SECRET_SENTINEL");
    expect(turns[0]?.systemPrompt).not.toContain("FINANCE_SECRET_SENTINEL");
    expect(statuses).toEqual(["turn-created", "consumed"]);
  });

  it("repairs one invalid structured decision then persists clarification", async () => {
    let calls = 0;
    const statuses: string[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [{ workbenchId: "research", name: "研究", scopeSummary: "技术研究", updatedAt: research.updatedAt }] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { calls += 1; return { action: "select", workbenchId: "missing" }; } },
      runtime: { abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false, startTurn: async () => undefined, steer: () => undefined, waitForIdle: async () => undefined },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: { completeInput: async () => undefined, createTurn: async () => undefined, loadInput: async () => ({ body: "ambiguous", inputId: "input-1", status: "PENDING" }), requireClarification: async () => { statuses.push("clarify"); } },
    });
    await coordinator.handle("input-1");
    expect(calls).toBe(2);
    expect(statuses).toEqual(["clarify"]);
  });

  it("handles missing, consumed and concurrently removed inputs safely", async () => {
    const base = {
      workbenches: { getWorkbench: async () => null, listSummaries: async () => [{ workbenchId: "research", name: "研究", scopeSummary: "技术研究", updatedAt: research.updatedAt }] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => ({ action: "select", workbenchId: "research" }) },
      runtime: { abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false, startTurn: async () => undefined, steer: () => undefined, waitForIdle: async () => undefined },
      sources: { selectInitial: async (turnId: string) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
    };
    const missing = new JoiCoordinator({ ...base, store: { completeInput: async () => undefined, createTurn: async () => undefined, loadInput: async () => null, requireClarification: async () => undefined } });
    await expect(missing.handle("missing")).rejects.toMatchObject({ code: "joi_input_not_found" });
    let routed = 0;
    const consumed = new JoiCoordinator({ ...base, router: { decide: async () => { routed += 1; return null; } }, store: { completeInput: async () => undefined, createTurn: async () => undefined, loadInput: async () => ({ body: "done", inputId: "done", status: "CONSUMED" }), requireClarification: async () => undefined } });
    await consumed.handle("done");
    expect(routed).toBe(0);
    const reasons: string[] = [];
    const removed = new JoiCoordinator({ ...base, store: { completeInput: async () => undefined, createTurn: async () => undefined, loadInput: async () => ({ body: "route", inputId: "input", status: "PENDING" }), requireClarification: async (_id, reason) => { reasons.push(reason); } } });
    await removed.handle("input");
    expect(reasons).toEqual(["workbench_not_found"]);
  });

  it("creates the first Workbench through the registry and restores the input when reasoning fails", async () => {
    const created: unknown[] = [];
    const failed: string[] = [];
    const coordinator = new JoiCoordinator({
      workbenchRegistry: {
        create: async (input) => { created.push(input); return research; },
      },
      workbenches: { getWorkbench: async () => null, listSummaries: async () => [] },
      clock: new TestClock(),
      ids: new TestIds(),
      router: { decide: async () => ({
        action: "create",
        name: "研究",
        personaSummary: "研究上下文",
        projectLabel: "研究工程",
        scopeSummary: "技术研究",
      }) },
      runtime: {
        abort: () => undefined,
        followUp: () => undefined,
        isRunning: () => false,
        restore: async () => false, rollbackTurn: async () => false,
        startTurn: async () => { throw new Error("provider offline"); },
        steer: () => undefined,
        waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => undefined,
        createTurn: async () => undefined,
        failTurn: async (inputId, turnId) => { failed.push(`${inputId}:${turnId}`); },
        loadInput: async () => ({ body: "new research", inputId: "input-new", status: "PENDING" }),
        requireClarification: async () => undefined,
      },
    });

    await expect(coordinator.handle("input-new")).rejects.toThrow("provider offline");
    expect(created).toEqual([expect.objectContaining({ name: "研究", scopeSummary: "技术研究" })]);
    expect(failed).toEqual([expect.stringMatching(/^input-new:turn_/u)]);
  });

  it("bootstraps a deterministic workbench Workbench when no Workbench exists and routing cannot decide", async () => {
    const created: unknown[] = [];
    const turns: StartReasoningTurnInput[] = [];
    const clarifications: string[] = [];
    const coordinator = new JoiCoordinator({
      workbenchRegistry: { create: async (input) => { created.push(input); return research; } },
      workbenches: { getWorkbench: async () => null, listSummaries: async () => [] },
      clock: new TestClock(),
      ids: new TestIds(),
      router: { decide: async () => ({ action: "select", workbenchId: "ghost" }) },
      runtime: {
        abort: () => undefined,
        followUp: () => undefined,
        isRunning: () => false,
        restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => { turns.push(turn); },
        steer: () => undefined,
        waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => undefined,
        createTurn: async () => undefined,
        loadInput: async () => ({ body: "我想为『复现并诊断缺陷』这类工作组建搭档团队", inputId: "input-boot", status: "PENDING" }),
        requireClarification: async (_inputId, reason) => { clarifications.push(reason); },
      },
    });
    await coordinator.handle("input-boot");
    expect(clarifications).toEqual([]);
    expect(created).toEqual([expect.objectContaining({ name: "joi 工作台" })]);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.workbenchId).toBe("research");
    expect(turns[0]?.systemPrompt).toContain("RESEARCH_SECRET_SENTINEL");
  });

  it("does not create a workbench when no registry is available", async () => {
    const reasons: string[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => null, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => ({ action: "create", name: "New", personaSummary: "Context", projectLabel: "Project", scopeSummary: "Scope" }) },
      runtime: { abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false, startTurn: async () => undefined, steer: () => undefined, waitForIdle: async () => undefined },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => undefined,
        createTurn: async () => undefined,
        loadInput: async () => ({ body: "new", inputId: "input-new", status: "PENDING" }),
        requireClarification: async (_inputId, reason) => { reasons.push(reason); },
      },
    });
    await coordinator.handle("input-new");
    expect(reasons).toEqual(["workbench_selection_invalid"]);
  });

  it("retries the same pinned turn on the next source only before output or side effects", async () => {
    const turns: StartReasoningTurnInput[] = [];
    const sourceUpdates: string[] = [];
    const runtime: PrimaryReasoningRuntime = {
      abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
      startTurn: async (turn) => {
        turns.push(turn);
        if (turn.sourceId === "primary") throw new Error("network timeout");
      },
      steer: () => undefined, waitForIdle: async () => undefined,
    };
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [{ workbenchId: "research", name: "研究", scopeSummary: "技术研究", updatedAt: research.updatedAt }] },
      clock: new TestClock(),
      failureClassifier: { classify: () => "timeout" },
      ids: new TestIds(),
      router: { decide: async () => ({ action: "select", workbenchId: "research" }) },
      runtime,
      sources: {
        selectFallback: async () => ({ modelId: "fallback-model", modelRevisionId: "fallback-mr", sourceId: "fallback", sourceRevisionId: "fallback-sr", turnId: "turn" }),
        selectInitial: async (turnId) => ({ modelId: "primary-model", modelRevisionId: "primary-mr", sourceId: "primary", sourceRevisionId: "primary-sr", turnId }),
      },
      store: {
        completeInput: async () => undefined,
        createTurn: async () => undefined,
        loadInput: async () => ({ body: "research", inputId: "input-fallback", status: "PENDING" }),
        requireClarification: async () => undefined,
        updateTurnSource: async (_turnId, sourceRevisionId) => { sourceUpdates.push(sourceRevisionId); },
      },
    });

    await coordinator.handle("input-fallback");
    expect(turns.map((turn) => turn.sourceId)).toEqual(["primary", "fallback"]);
    expect(turns[0]?.turnId).toBe(turns[1]?.turnId);
    expect(sourceUpdates).toEqual(["fallback-sr"]);
  });

  it("isolates repeated new requests and retains only the same input's session on clarification", async () => {
    const sessions: string[] = [];
    const prompts: string[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => ({ ...research, taskContext: { activeWorkIds: ["previous-work"], summary: "OLD_TASK_ALREADY_RUNNING" } }), listSummaries: async () => [{ workbenchId: "research", name: "研究", scopeSummary: "技术研究", updatedAt: research.updatedAt }] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => ({ action: "select", workbenchId: "research" }) },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => { sessions.push(turn.sessionId); prompts.push(turn.systemPrompt); }, steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => undefined, createTurn: async () => undefined,
        loadInput: async (inputId) => ({ body: "使用飞书项目，分析我的待办工作", inputId, status: "PENDING" }),
        requireClarification: async () => undefined,
      },
    });
    await coordinator.handle("input-1");
    await coordinator.handle("input-2");
    await coordinator.handle("input-2");
    expect(sessions).toEqual(["joi_session:research:input-1", "joi_session:research:input-2", "joi_session:research:input-2"]);
    expect(prompts.every((prompt) => !prompt.includes("OLD_TASK_ALREADY_RUNNING"))).toBe(true);
  });

  it("never falls back after formal output or a tool side effect has started", async () => {
    const progress: { formalOutputStarted: boolean; sideEffectStarted: boolean }[] = [];
    const fallbackInputs: unknown[] = [];
    const failed: string[] = [];
    const emitted: string[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), events: { emit: async (type) => { emitted.push(type); } },
      failureClassifier: { classify: () => "timeout" }, ids: new TestIds(),
      router: { decide: async () => { throw new Error("pre-bound result must not route again"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => {
          turn.onEvent?.({ delta: "", turnId: turn.turnId, type: "text_delta" });
          turn.onEvent?.({ delta: "visible", turnId: turn.turnId, type: "text_delta" });
          turn.onEvent?.({ toolCallId: "tool-1", toolName: "work_dispatch", turnId: turn.turnId, type: "tool_started" });
          throw new Error("timeout after side effect");
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: {
        selectFallback: async (input) => { fallbackInputs.push(input); return null; },
        selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }),
      },
      store: {
        completeInput: async () => undefined, createTurn: async () => undefined,
        failTurn: async (_inputId, turnId) => { failed.push(turnId); },
        loadInput: async () => ({ workbenchId: "research", body: "partner result", inputId: "result", status: "PENDING" }),
        recordTurnProgress: async (_turnId, value) => { progress.push(value); },
        requireClarification: async () => undefined,
      },
    });

    await expect(coordinator.handle("result")).rejects.toThrow("timeout after side effect");
    expect(fallbackInputs).toEqual([expect.objectContaining({ formalOutputStarted: true, sideEffectStarted: true })]);
    expect(progress.at(-1)).toEqual({ formalOutputStarted: true, sideEffectStarted: true });
    expect(failed).toHaveLength(1);
    expect(emitted).toEqual(["joi.turn.started", "joi.turn.failed"]);
  });

  it("does not classify a read-only tool as a replay-unsafe side effect", async () => {
    const fallbackInputs: unknown[] = [];
    const progress: { formalOutputStarted: boolean; sideEffectStarted: boolean }[] = [];
    const coordinator = new JoiCoordinator({
      workbenches: { getWorkbench: async () => research, listSummaries: async () => [] },
      clock: new TestClock(),
      failureClassifier: { classify: () => "timeout" }, ids: new TestIds(),
      router: { decide: async () => { throw new Error("pre-bound result must not route again"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false,
        restore: async () => false, rollbackTurn: async () => false,
        startTurn: async (turn) => {
          turn.onEvent?.({ toolCallId: "read-1", toolName: "work_read_result", turnId: turn.turnId, type: "tool_started" });
          throw new Error("timeout after read");
        },
        steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: {
        selectFallback: async (input) => { fallbackInputs.push(input); return null; },
        selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }),
      },
      store: {
        completeInput: async () => undefined, createTurn: async () => undefined,
        failTurn: async () => undefined,
        loadInput: async () => ({ body: "review", goalInputId: "goal-read", inputId: "joi_harness_review:goal:goal-read:r1", status: "PENDING" as const, workbenchId: "research" }),
        recordTurnProgress: async (_turnId, value) => { progress.push(value); },
        requireClarification: async () => undefined,
      },
    });

    await expect(coordinator.handle("joi_harness_review:goal:goal-read:r1")).rejects.toThrow("timeout after read");
    expect(fallbackInputs).toEqual([expect.objectContaining({ formalOutputStarted: false, sideEffectStarted: false })]);
    expect(progress).toEqual([]);
  });
});
