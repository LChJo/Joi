/* Test doubles resolve synchronously through Promise contracts. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { PrimaryReasoningRuntime } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { createAvatar } from "../../src/main/domain/avatar/avatar.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const avatar = createAvatar({
  avatarId: "avatar", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory", name: "Code",
  personaRevisionId: "persona", personaSummary: "Careful", project: { label: "Repo" }, scopeSummary: "Code",
  taskContext: { activeWorkIds: [], summary: "" },
});

function coordinator(mode: "lookup" | "none" | "outcome", completed: string[], failed: string[], diagnostics: string[] = []) {
  const runtime: PrimaryReasoningRuntime = {
    abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
    startTurn: async (turn) => {
      if (mode === "none") return;
      const toolName = mode === "lookup" ? "partner_list_available" : "turn_complete";
      turn.onEvent?.({ toolCallId: "tool", toolName, turnId: turn.turnId, type: "tool_started" });
      turn.onEvent?.({ isError: false, toolCallId: "tool", toolName, turnId: turn.turnId, type: "tool_finished" });
    },
    steer: () => undefined, waitForIdle: async () => undefined,
  };
  return new JoiCoordinator({
    avatars: { getAvatar: async () => avatar, listSummaries: async () => [] },
    clock: new TestClock(), ids: new TestIds(),
    diagnostics: { emit: (event) => { diagnostics.push(event); } },
    router: { decide: async () => { throw new Error("pre-bound"); } }, runtime,
    sources: { selectInitial: async (turnId) => ({
      modelCapability: "custom-unverified-tools", modelId: "custom", modelRevisionId: "mr",
      sourceId: "source", sourceRevisionId: "sr", turnId,
    }) },
    store: {
      completeInput: async (inputId) => { completed.push(inputId); }, createTurn: async () => undefined,
      failTurn: async (inputId) => { failed.push(inputId); },
      loadInput: async () => ({ avatarId: "avatar", body: "do work", inputId: "input", status: "PENDING" }),
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
      "joi.avatar.resolved",
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
      abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
      startTurn: async (turn) => {
        prompts.push(turn.prompt);
        const toolName = prompts.length === 1 ? "partner_list_available" : "work_dispatch";
        turn.onEvent?.({ toolCallId: `tool-${String(prompts.length)}`, toolName, turnId: turn.turnId, type: "tool_started" });
        turn.onEvent?.({ isError: false, toolCallId: `tool-${String(prompts.length)}`, toolName, turnId: turn.turnId, type: "tool_finished" });
      },
      steer: () => undefined, waitForIdle: async () => undefined,
    };
    const subject = new JoiCoordinator({
      avatars: { getAvatar: async () => avatar, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      diagnostics: { emit: (event, fields) => { diagnostics.push({ event, fields }); } },
      router: { decide: async () => { throw new Error("pre-bound"); } }, runtime,
      sources: { selectInitial: async (turnId) => ({
        modelCapability: "custom-unverified-tools", modelId: "custom", modelRevisionId: "mr",
        sourceId: "source", sourceRevisionId: "sr", turnId,
      }) },
      store: {
        completeInput: async (inputId) => { completed.push(inputId); }, createTurn: async () => undefined,
        loadInput: async () => ({ avatarId: "avatar", body: "analyze the stock", inputId: "input", status: "PENDING" }),
        requireClarification: async () => undefined,
      },
    });

    await subject.handle("input");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("did not commit an outcome");
    expect(completed).toEqual(["input"]);
    expect(diagnostics.find((entry) => entry.event === "joi.turn.completed")?.fields).toMatchObject({
      avatarId: "avatar",
      inputId: "input",
      outcomeTools: ["work_dispatch"],
      repaired: true,
    });
  });
});
