/* Orchestration test doubles resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { JoiCoordinatorStore } from "../../src/main/application/ports/joi-coordinator.js";
import type { PrimaryReasoningRuntime, StartReasoningTurnInput } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { createAvatar } from "../../src/main/domain/avatar/avatar.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const research = createAvatar({
  avatarId: "research", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory-research", name: "研究",
  personaRevisionId: "persona-r", personaSummary: "RESEARCH_SECRET_SENTINEL", project: { label: "研究工程" }, scopeSummary: "技术研究", taskContext: { activeWorkIds: [], summary: "" },
});
const finance = createAvatar({
  avatarId: "finance", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory-finance", name: "财务",
  personaRevisionId: "persona-f", personaSummary: "FINANCE_SECRET_SENTINEL", project: { label: "财务工程" }, scopeSummary: "财务事务", taskContext: { activeWorkIds: [], summary: "" },
});

describe("single-joi-avatar-scoped-thread-isolation", () => {
  it("runs result synthesis in an isolated session and persists the bounded final answer for the original goal", async () => {
    const completions: unknown[] = [];
    const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
    const sessions: string[] = [];
    const coordinator = new JoiCoordinator({
      avatars: { getAvatar: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
      router: { decide: async () => { throw new Error("synthesis input is pre-bound"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
        startTurn: async (turn) => {
          sessions.push(turn.sessionId);
          turn.onEvent?.({ delta: "两项工作已完成。 C:\\private\\file 已隐藏。", turnId: turn.turnId, type: "text_delta" });
          turn.onEvent?.({ toolCallId: "complete", toolName: "turn_complete", turnId: turn.turnId, type: "tool_started" });
          turn.onEvent?.({ isError: false, toolCallId: "complete", toolName: "turn_complete", turnId: turn.turnId, type: "tool_finished" });
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
          avatarId: "research", body: "synthesize", goalInputId: "goal-1", inputId: "joi_result_input:goal:goal-1",
          resultRevision: 2, status: "PENDING",
        }),
        requireClarification: async () => undefined,
      },
    });

    await coordinator.handle("joi_result_input:goal:goal-1");
    expect(sessions).toEqual(["joi_synthesis_session:research"]);
    expect(completions).toEqual([expect.objectContaining({
      completion: { completionSummary: "两项工作已完成。 [redacted-path] 已隐藏。" },
      inputId: "joi_result_input:goal:goal-1",
    })]);
    expect(diagnostics.map((entry) => entry.event)).toEqual(expect.arrayContaining([
      "joi.goal.synthesis.started", "joi.goal.synthesis.completed", "joi.goal.outcome.persisted",
    ]));
  });

  it("routes from summaries then gives the one global runtime only the selected Avatar body", async () => {
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
      abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
      startTurn: async (turn) => { turns.push(turn); }, steer: () => undefined, waitForIdle: async () => undefined,
    };
    const coordinator = new JoiCoordinator({
      avatars: {
        getAvatar: async (avatarId) => avatarId === "research" ? research : avatarId === "finance" ? finance : null,
        listSummaries: async () => [research, finance].map((avatar) => ({ avatarId: avatar.avatarId, name: avatar.profile.name, scopeSummary: avatar.profile.scopeSummary, updatedAt: avatar.updatedAt })),
      },
      clock: new TestClock(), ids: new TestIds(), runtime,
      router: { decide: async (input) => { observedRouting.push(input); return { action: "select", avatarId: "research" }; } },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store,
    });
    await coordinator.handle("input-1");
    expect(JSON.stringify(observedRouting)).not.toMatch(/RESEARCH_SECRET_SENTINEL|FINANCE_SECRET_SENTINEL/u);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.avatarId).toBe("research");
    expect(turns[0]?.systemPrompt).toContain("RESEARCH_SECRET_SENTINEL");
    expect(turns[0]?.systemPrompt).not.toContain("FINANCE_SECRET_SENTINEL");
    expect(statuses).toEqual(["turn-created", "consumed"]);
  });

  it("repairs one invalid structured decision then persists clarification", async () => {
    let calls = 0;
    const statuses: string[] = [];
    const coordinator = new JoiCoordinator({
      avatars: { getAvatar: async () => research, listSummaries: async () => [{ avatarId: "research", name: "研究", scopeSummary: "技术研究", updatedAt: research.updatedAt }] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { calls += 1; return { action: "select", avatarId: "missing" }; } },
      runtime: { abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, startTurn: async () => undefined, steer: () => undefined, waitForIdle: async () => undefined },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: { completeInput: async () => undefined, createTurn: async () => undefined, loadInput: async () => ({ body: "ambiguous", inputId: "input-1", status: "PENDING" }), requireClarification: async () => { statuses.push("clarify"); } },
    });
    await coordinator.handle("input-1");
    expect(calls).toBe(2);
    expect(statuses).toEqual(["clarify"]);
  });

  it("handles missing, consumed and concurrently removed inputs safely", async () => {
    const base = {
      avatars: { getAvatar: async () => null, listSummaries: async () => [{ avatarId: "research", name: "研究", scopeSummary: "技术研究", updatedAt: research.updatedAt }] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => ({ action: "select", avatarId: "research" }) },
      runtime: { abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, startTurn: async () => undefined, steer: () => undefined, waitForIdle: async () => undefined },
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
    expect(reasons).toEqual(["avatar_not_found"]);
  });

  it("creates the first Avatar through the registry and restores the input when reasoning fails", async () => {
    const created: unknown[] = [];
    const failed: string[] = [];
    const coordinator = new JoiCoordinator({
      avatarRegistry: {
        create: async (input) => { created.push(input); return research; },
      },
      avatars: { getAvatar: async () => null, listSummaries: async () => [] },
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
        restore: async () => false,
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

  it("bootstraps a deterministic workbench Avatar when no Avatar exists and routing cannot decide", async () => {
    const created: unknown[] = [];
    const turns: StartReasoningTurnInput[] = [];
    const clarifications: string[] = [];
    const coordinator = new JoiCoordinator({
      avatarRegistry: { create: async (input) => { created.push(input); return research; } },
      avatars: { getAvatar: async () => null, listSummaries: async () => [] },
      clock: new TestClock(),
      ids: new TestIds(),
      router: { decide: async () => ({ action: "select", avatarId: "ghost" }) },
      runtime: {
        abort: () => undefined,
        followUp: () => undefined,
        isRunning: () => false,
        restore: async () => false,
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
    expect(turns[0]?.avatarId).toBe("research");
    expect(turns[0]?.systemPrompt).toContain("RESEARCH_SECRET_SENTINEL");
  });

  it("does not create an Avatar when no registry is available", async () => {
    const reasons: string[] = [];
    const coordinator = new JoiCoordinator({
      avatars: { getAvatar: async () => null, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => ({ action: "create", name: "New", personaSummary: "Context", projectLabel: "Project", scopeSummary: "Scope" }) },
      runtime: { abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, startTurn: async () => undefined, steer: () => undefined, waitForIdle: async () => undefined },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => undefined,
        createTurn: async () => undefined,
        loadInput: async () => ({ body: "new", inputId: "input-new", status: "PENDING" }),
        requireClarification: async (_inputId, reason) => { reasons.push(reason); },
      },
    });
    await coordinator.handle("input-new");
    expect(reasons).toEqual(["avatar_selection_invalid"]);
  });

  it("retries the same pinned turn on the next source only before output or side effects", async () => {
    const turns: StartReasoningTurnInput[] = [];
    const sourceUpdates: string[] = [];
    const runtime: PrimaryReasoningRuntime = {
      abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
      startTurn: async (turn) => {
        turns.push(turn);
        if (turn.sourceId === "primary") throw new Error("network timeout");
      },
      steer: () => undefined, waitForIdle: async () => undefined,
    };
    const coordinator = new JoiCoordinator({
      avatars: { getAvatar: async () => research, listSummaries: async () => [{ avatarId: "research", name: "研究", scopeSummary: "技术研究", updatedAt: research.updatedAt }] },
      clock: new TestClock(),
      failureClassifier: { classify: () => "timeout" },
      ids: new TestIds(),
      router: { decide: async () => ({ action: "select", avatarId: "research" }) },
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

  it("reuses one Avatar-scoped Pi session across consecutive safe-boundary turns", async () => {
    const sessions: string[] = [];
    let input = 0;
    const coordinator = new JoiCoordinator({
      avatars: { getAvatar: async () => research, listSummaries: async () => [{ avatarId: "research", name: "研究", scopeSummary: "技术研究", updatedAt: research.updatedAt }] },
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => ({ action: "select", avatarId: "research" }) },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
        startTurn: async (turn) => { sessions.push(turn.sessionId); }, steer: () => undefined, waitForIdle: async () => undefined,
      },
      sources: { selectInitial: async (turnId) => ({ modelId: "model", modelRevisionId: "model-r", sourceId: "source", sourceRevisionId: "source-r", turnId }) },
      store: {
        completeInput: async () => undefined, createTurn: async () => undefined,
        loadInput: async () => ({ body: "next", inputId: `input-${String(++input)}`, status: "PENDING" }),
        requireClarification: async () => undefined,
      },
    });
    await coordinator.handle("input-1");
    await coordinator.handle("input-2");
    expect(sessions).toEqual(["joi_session:research", "joi_session:research"]);
  });

  it("never falls back after formal output or a tool side effect has started", async () => {
    const progress: { formalOutputStarted: boolean; sideEffectStarted: boolean }[] = [];
    const fallbackInputs: unknown[] = [];
    const failed: string[] = [];
    const emitted: string[] = [];
    const coordinator = new JoiCoordinator({
      avatars: { getAvatar: async () => research, listSummaries: async () => [] },
      clock: new TestClock(), events: { emit: async (type) => { emitted.push(type); } },
      failureClassifier: { classify: () => "timeout" }, ids: new TestIds(),
      router: { decide: async () => { throw new Error("pre-bound result must not route again"); } },
      runtime: {
        abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
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
        loadInput: async () => ({ avatarId: "research", body: "partner result", inputId: "result", status: "PENDING" }),
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
});
