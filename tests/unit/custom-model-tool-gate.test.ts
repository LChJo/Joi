/* Test doubles resolve synchronously through Promise contracts. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { PrimaryReasoningRuntime } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const workbench = createWorkbench({
  workbenchId: "workbench", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory", name: "Code",
  personaRevisionId: "persona", personaSummary: "Careful", project: { label: "Repo" }, scopeSummary: "Code",
  taskContext: { activeWorkIds: [], summary: "" },
});

interface ToolProofState {
  proven: boolean;
  recorded: { modelRevisionId: string; provenAt: string; sourceRevisionId: string }[];
}

const unproven = (): ToolProofState => ({ proven: false, recorded: [] });

function coordinator(mode: "lookup" | "none" | "outcome", completed: string[], failed: string[], diagnostics: string[] = [], proof: ToolProofState = unproven()) {
  const runtime: PrimaryReasoningRuntime = {
    abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
    startTurn: async (turn) => {
      if (mode === "none") return;
      const toolName = mode === "lookup" ? "partner_list_available" : "turn_complete";
      turn.onEvent?.({ toolCallId: "tool", toolName, turnId: turn.turnId, type: "tool_started" });
      turn.onEvent?.({ isError: false, toolCallId: "tool", toolName, turnId: turn.turnId, type: "tool_finished" });
    },
    steer: () => undefined, waitForIdle: async () => undefined,
  };
  return new JoiCoordinator({
    workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
    clock: new TestClock(), ids: new TestIds(),
    diagnostics: { emit: (event) => { diagnostics.push(event); } },
    router: { decide: async () => { throw new Error("pre-bound"); } }, runtime,
    sources: {
      recordToolProof: async (input) => { proof.recorded.push(input); proof.proven = true; },
      selectInitial: async (turnId) => ({
        modelCapability: "custom-unverified-tools" as const, modelId: "custom", modelRevisionId: "mr",
        sourceId: "source", sourceRevisionId: "sr", toolCapabilityProven: proof.proven, turnId,
      }),
    },
    store: {
      completeInput: async (inputId) => { completed.push(inputId); }, createTurn: async () => undefined,
      failTurn: async (inputId) => { failed.push(inputId); },
      loadInput: async () => ({ workbenchId: "workbench", body: "do work", inputId: "input", status: "PENDING" }),
      requireClarification: async () => undefined,
    },
  });
}

describe("custom model tool capability gate", () => {
  it("fails closed until the first real Turn demonstrates a structured outcome tool call", async () => {
    const completed: string[] = [];
    const failed: string[] = [];
    await expect(coordinator("none", completed, failed).handle("input")).rejects.toMatchObject({ code: "custom_model_tool_capability_unverified" });
    expect(failed).toEqual(["input"]);
    await coordinator("outcome", completed, failed).handle("input");
    expect(completed).toEqual(["input"]);
  });

  it("records the tool proof once demonstrated and lets later direct answers through", async () => {
    const completed: string[] = [];
    const failed: string[] = [];
    const proof = unproven();
    await coordinator("outcome", completed, failed, [], proof).handle("input");
    expect(completed).toEqual(["input"]);
    expect(proof.recorded).toMatchObject([{ modelRevisionId: "mr", sourceRevisionId: "sr" }]);
    expect(proof.proven).toBe(true);
    // A later greeting Turn answers directly with zero tool calls: proven capability must not fail closed.
    await coordinator("none", completed, failed, [], proof).handle("input");
    expect(completed).toEqual(["input", "input"]);
    expect(failed).toEqual([]);
  });

  it("does not consume an input when both the original and repair attempt use lookup tools only", async () => {
    const completed: string[] = [];
    const diagnostics: string[] = [];
    const failed: string[] = [];
    await expect(coordinator("lookup", completed, failed, diagnostics).handle("input"))
      .rejects.toMatchObject({ code: "joi_turn_outcome_uncommitted" });
    expect(completed).toEqual([]);
    expect(failed).toEqual(["input"]);
    expect(diagnostics).toEqual(expect.arrayContaining([
      "joi.input.handling_started",
      "joi.workbench.resolved",
      "joi.turn.started",
      "joi.tool.started",
      "joi.tool.finished",
      "joi.turn.repair_requested",
      "joi.turn.failed",
    ]));
  });

  it("repairs a lookup-only response once and completes only after work is dispatched", async () => {
    const prompts: string[] = [];
    const completed: string[] = [];
    const diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
    const runtime: PrimaryReasoningRuntime = {
      abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false, rollbackTurn: async () => false,
      startTurn: async (turn) => {
        prompts.push(turn.prompt);
        const toolName = prompts.length === 1 ? "partner_list_available" : "work_dispatch";
        turn.onEvent?.({ toolCallId: `tool-${String(prompts.length)}`, toolName, turnId: turn.turnId, type: "tool_started" });
        turn.onEvent?.({ isError: false, toolCallId: `tool-${String(prompts.length)}`, toolName, turnId: turn.turnId, type: "tool_finished" });
      },
      steer: () => undefined, waitForIdle: async () => undefined,
    };
    const subject = new JoiCoordinator({
      workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
      router: { decide: async () => { throw new Error("pre-bound"); } }, runtime,
      sources: { selectInitial: async (turnId) => ({
        modelCapability: "custom-unverified-tools", modelId: "custom", modelRevisionId: "mr",
        sourceId: "source", sourceRevisionId: "sr", turnId,
      }) },
      store: {
        completeInput: async (inputId) => { completed.push(inputId); }, createTurn: async () => undefined,
        loadInput: async () => ({ workbenchId: "workbench", body: "analyze the stock", inputId: "input", status: "PENDING" }),
        requireClarification: async () => undefined,
      },
    });

    await subject.handle("input");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("did not commit an outcome");
    expect(completed).toEqual(["input"]);
    expect(diagnostics.find((entry) => entry.event === "joi.turn.completed")?.fields).toMatchObject({
      workbenchId: "workbench",
      inputId: "input",
      outcomeTools: ["work_dispatch"],
      repaired: true,
    });
  });
});
