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

function coordinator(observeTool: boolean, completed: string[], failed: string[]) {
  const runtime: PrimaryReasoningRuntime = {
    abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
    startTurn: async (turn) => {
      if (observeTool) turn.onEvent?.({ toolCallId: "tool", toolName: "partner.list_available", turnId: turn.turnId, type: "tool_started" });
    },
    steer: () => undefined, waitForIdle: async () => undefined,
  };
  return new JoiCoordinator({
    avatars: { getAvatar: async () => avatar, listSummaries: async () => [] },
    clock: new TestClock(), ids: new TestIds(),
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
  it("fails closed until the first real Turn demonstrates a structured tool call", async () => {
    const completed: string[] = [];
    const failed: string[] = [];
    await expect(coordinator(false, completed, failed).handle("input")).rejects.toMatchObject({ code: "custom_model_tool_capability_unverified" });
    expect(failed).toEqual(["input"]);
    await coordinator(true, completed, failed).handle("input");
    expect(completed).toEqual(["input"]);
  });
});
