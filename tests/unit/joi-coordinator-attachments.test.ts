/* Test doubles resolve synchronously through Promise contracts. */
/* eslint-disable @typescript-eslint/require-await */
import { JoiCoordinator } from "../../src/main/application/joi/joi-coordinator.js";
import type { JoiAttachmentPort } from "../../src/main/application/ports/managed-file-ports.js";
import type { PrimaryReasoningRuntime, StartReasoningTurnInput } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const workbench = createWorkbench({
  workbenchId: "workbench", createdAt: "2026-07-28T10:00:00.000Z", memoryNamespaceId: "memory", name: "Code",
  personaRevisionId: "persona", personaSummary: "Careful", project: { label: "Repo" }, scopeSummary: "Code",
  taskContext: { activeWorkIds: [], summary: "" },
});

const pngBytes = "iVBOR-fake";

function capturedRuntime(mode: "lookup-then-outcome" | "outcome") {
  const turns: StartReasoningTurnInput[] = [];
  const runtime: PrimaryReasoningRuntime = {
    abort: () => undefined, followUp: () => undefined, isRunning: () => false, restore: async () => false,
    startTurn: async (turn) => {
      turns.push(turn);
      const toolName = mode === "outcome" || turns.length > 1 ? "turn_complete" : "partner_list_available";
      turn.onEvent?.({ toolCallId: `tool-${String(turns.length)}`, toolName, turnId: turn.turnId, type: "tool_started" });
      turn.onEvent?.({ isError: false, toolCallId: `tool-${String(turns.length)}`, toolName, turnId: turn.turnId, type: "tool_finished" });
    },
    steer: () => undefined, waitForIdle: async () => undefined,
  };
  return { runtime, turns };
}

function coordinator(runtime: PrimaryReasoningRuntime, attachments?: Pick<JoiAttachmentPort, "read">, readerFails = false) {
  const completed: string[] = [];
  return {
    completed,
    subject: new JoiCoordinator({
      workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] },
      ...(attachments === undefined ? {} : { attachments }),
      clock: new TestClock(), ids: new TestIds(),
      router: { decide: async () => { throw new Error("pre-bound"); } }, runtime,
      sources: { selectInitial: async (turnId) => ({
        modelId: "model", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId,
      }) },
      store: {
        completeInput: async (inputId) => { completed.push(inputId); }, createTurn: async () => undefined,
        loadInput: async () => ({
          workbenchId: "workbench",
          attachments: readerFails
            ? [{ attachmentId: "att_text", filename: "brief.md", mimeType: "text/markdown", size: 20 }]
            : [
                { attachmentId: "att_text", filename: "brief.md", mimeType: "text/markdown", size: 20 },
                { attachmentId: "att_image", filename: "shot.png", mimeType: "image/png", size: pngBytes.length },
              ],
          body: "按附件执行", inputId: "input", status: "PENDING" as const,
        }),
        requireClarification: async () => undefined,
      },
    }),
  };
}

const reader = async (attachmentId: string) => {
  if (attachmentId === "att_image") return { bytes: new TextEncoder().encode(pngBytes), filename: "shot.png", mimeType: "image/png" };
  return { bytes: new TextEncoder().encode("# 简报\n照此执行。"), filename: "brief.md", mimeType: "text/markdown" };
};

describe("joi coordinator attachment delivery", () => {
  it("inlines text attachments and forwards image parts plus scoped ids on the first turn", async () => {
    const { runtime, turns } = capturedRuntime("outcome");
    const { subject } = coordinator(runtime, { read: reader });
    await subject.handle("input");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.prompt).toContain("按附件执行");
    expect(turns[0]?.prompt).toContain('<joi-attachment attachmentId="att_text" name="brief.md" mime="text/markdown">');
    expect(turns[0]?.prompt).toContain("照此执行。");
    expect(turns[0]?.prompt).toContain("shot.png");
    expect(turns[0]?.images).toEqual([{ data: btoa(pngBytes), mimeType: "image/png" }]);
    expect(turns[0]?.attachmentIds).toEqual(["att_text", "att_image"]);
  });

  it("does not resend attachment content or images on the outcome-repair turn", async () => {
    const { runtime, turns } = capturedRuntime("lookup-then-outcome");
    const { subject, completed } = coordinator(runtime, { read: reader });
    await subject.handle("input");
    expect(turns).toHaveLength(2);
    expect(turns[1]?.prompt).toContain("did not commit an outcome");
    expect(turns[1]?.prompt).not.toContain("joi-attachment attachmentId");
    expect(turns[1]?.images).toBeUndefined();
    expect(turns[1]?.attachmentIds).toEqual(["att_text", "att_image"]);
    expect(completed).toEqual(["input"]);
  });

  it("keeps the prompt body-only when the attachment reader is not wired", async () => {
    const { runtime, turns } = capturedRuntime("outcome");
    const { subject } = coordinator(runtime);
    await subject.handle("input");
    expect(turns[0]?.prompt).toBe("按附件执行");
    expect(turns[0]?.images).toBeUndefined();
    expect(turns[0]?.attachmentIds).toBeUndefined();
  });

  it("survives verified-read failures by degrading to metadata notes", async () => {
    const { runtime, turns } = capturedRuntime("outcome");
    const failing = async () => { throw new Error("integrity"); };
    const { subject, completed } = coordinator(runtime, { read: failing }, true);
    await subject.handle("input");
    expect(completed).toEqual(["input"]);
    expect(turns[0]?.prompt).toContain("could not be read");
    expect(turns[0]?.prompt).toContain("att_text brief.md text/markdown 20 bytes");
    expect(turns[0]?.images).toBeUndefined();
  });
});
