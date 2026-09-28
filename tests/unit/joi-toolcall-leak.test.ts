/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { PrimaryReasoningRuntime } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { PiReasoningFailureClassifier } from "../../src/main/infrastructure/pi/pi-reasoning-failure-classifier.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const workbench = createWorkbench({
  workbenchId: "workbench", createdAt: "2026-09-28T10:00:00.000Z", memoryNamespaceId: "memory", name: "Code",
  personaRevisionId: "persona", personaSummary: "Careful", project: { label: "Repo" }, scopeSummary: "Code",
  taskContext: { activeWorkIds: [], summary: "" },
});

const LEAKED_TEXT = '<｜｜DSML｜｜ invoke name="user_ask"><｜｜DSML｜｜ parameter name="question">which files?</parameter>';

interface Completions {
  completed: string[];
  outcomes: unknown[];
}

function coordinator(runtime: PrimaryReasoningRuntime, options?: {
  avoidCalls?: { millis: number; sourceId: string }[];
  fallbackSourceId?: string;
}): { subject: JoiCoordinator; completions: Completions; diagnostics: { event: string; fields: Record<string, unknown> }[]; prompts: string[] } {
  const completions: Completions = { completed: [], outcomes: [] };
  const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
  const prompts: string[] = [];
  const subject = new JoiCoordinator({
    workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
    clock: new TestClock(), ids: new TestIds(),
    diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
    failureClassifier: new PiReasoningFailureClassifier(),
    router: { decide: async () => { throw new Error("pre-bound"); } }, runtime,
    sources: {
      avoidSource: (sourceId, millis) => { options?.avoidCalls?.push({ millis, sourceId }); },
      ...(options?.fallbackSourceId === undefined ? {} : {
        selectFallback: async () => ({
          modelId: "other", modelRevisionId: "mr2", sourceId: options.fallbackSourceId ?? "source-b",
          sourceRevisionId: "sr2", turnId: "turn",
        }),
      }),
      selectInitial: async (turnId) => ({
        modelId: "custom", modelRevisionId: "mr", sourceId: "source",
        sourceRevisionId: "sr", turnId,
      }),
    },
    store: {
      completeInput: async (inputId, _turnId, completion) => {
        completions.completed.push(inputId);
        completions.outcomes.push(completion);
      }, createTurn: async () => undefined,
      loadInput: async () => ({ workbenchId: "workbench", body: "analyze and continue", inputId: "input", status: "PENDING" }),
      requireClarification: async () => undefined,
    },
  });
  return { completions, diagnostics, prompts, subject };
}

function textTurn(text: string): PrimaryReasoningRuntime {
  return {
    abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
    startTurn: async (turn) => {
      turn.onEvent?.({ delta: text, turnId: turn.turnId, type: "text_delta" });
      turn.onEvent?.({ turnId: turn.turnId, type: "turn_finished" });
    },
    steer: () => undefined, waitForIdle: async () => undefined,
  };
}

describe("leaked tool-call markup", () => {
  it("repairs a text-only leak once and completes when the answer comes back clean", async () => {
    const prompts: string[] = [];
    const leaky = textTurn(LEAKED_TEXT);
    const clean = textTurn("盘点已完成，详见报告。");
    const runtime: PrimaryReasoningRuntime = {
      ...leaky,
      startTurn: async (turn) => {
        prompts.push(turn.prompt);
        if (prompts.length === 1) await leaky.startTurn(turn);
        else await clean.startTurn(turn);
      },
    };
    const { completions, diagnostics, subject } = coordinator(runtime);
    await subject.handle("input");

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("tool-call repair");
    expect(completions.completed).toEqual(["input"]);
    expect(completions.outcomes[0]).toMatchObject({ outcome: "DIRECT_ANSWER" });
    expect(diagnostics.some((entry) => entry.event === "joi.turn.toolcall_leak_repair_requested")).toBe(true);
  });

  it("fails the turn as a protocol error when the repair still leaks markup", async () => {
    const prompts: string[] = [];
    const leaky = textTurn(LEAKED_TEXT);
    const runtime: PrimaryReasoningRuntime = {
      ...leaky,
      startTurn: async (turn) => {
        prompts.push(turn.prompt);
        await leaky.startTurn(turn);
      },
    };
    const avoidCalls: { millis: number; sourceId: string }[] = [];
    const { completions, diagnostics, subject } = coordinator(runtime, { avoidCalls });
    await expect(subject.handle("input")).rejects.toMatchObject({ code: "joi_model_toolcall_leak" });

    expect(prompts).toHaveLength(2);
    expect(completions.completed).toEqual([]);
    // The source that produced protocol garbage twice is skipped by later Turns.
    expect(avoidCalls).toEqual([{ millis: 30 * 60_000, sourceId: "source" }]);
    expect(diagnostics.some((entry) => entry.event === "joi.turn.toolcall_leak_repair_requested")).toBe(true);
  });

  it("falls back to another source after a leak even though formal output already started", async () => {
    const prompts: string[] = [];
    const leaky = textTurn(LEAKED_TEXT);
    const clean = textTurn("结论：剩余待办共 10 项。");
    const runtime: PrimaryReasoningRuntime = {
      ...leaky,
      startTurn: async (turn) => {
        prompts.push(turn.prompt);
        // The original source leaks on both the answer and the repair pass; only the
        // fallback route answers cleanly.
        if (prompts.length <= 2) await leaky.startTurn(turn);
        else await clean.startTurn(turn);
      },
    };
    const { completions, diagnostics, subject } = coordinator(runtime, { fallbackSourceId: "source-b" });
    await subject.handle("input");

    expect(prompts).toHaveLength(3);
    expect(completions.completed).toEqual(["input"]);
    expect(diagnostics.find((entry) => entry.event === "joi.turn.source_fallback")?.fields).toMatchObject({
      fromSourceId: "source",
      toSourceId: "source-b",
    });
  });
});
