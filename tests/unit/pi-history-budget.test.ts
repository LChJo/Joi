/* Provider doubles return deterministic promises. */
/* eslint-disable @typescript-eslint/require-await */
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createPiContextManager } from "../../src/main/infrastructure/pi/pi-context-manager.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { boundRequestByChars } from "../../src/main/infrastructure/pi/pi-model-budget.js";
import { createContextHistoryTool } from "../../src/main/infrastructure/pi/pi-history-tools.js";
import { transcriptFingerprint } from "../../src/main/infrastructure/pi/pi-compaction.js";

function fixture(provider: string) {
  const faux = fauxProvider({ provider });
  const models = createModels(); models.setProvider(faux.provider);
  return { faux, models, model: { ...faux.getModel(), contextWindow: 2_000_000 } };
}
function history(): AgentMessage[] {
  return [
    { role: "user", content: "MANDATORY_TASK", timestamp: 0 },
    ...Array.from({ length: 50 }, (_, index) => ({ role: "user" as const, content: `evidence-${String(index)} `.padEnd(4000, "x"), timestamp: index + 1 })),
  ];
}

describe("AC-43/48/53/67 context soft budget", () => {
  it("CHAT-20 re-evaluates an in-place source edit and keeps the outgoing view within budget",async () => {
    const f = fixture("pi-mutated-history");vi.spyOn(f.models,"completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("SUMMARY")]));
    const mutable = fauxAssistantMessage([fauxText("small")]);
    const messages: AgentMessage[] = [{ role: "user",content: "TASK",timestamp: 0 },mutable,fauxAssistantMessage([fauxText("Latest fact")])];
    const manager = createPiContextManager({ ...f,messagesMaxChars: 55_000,thinkingLevel: "high" });await manager.transformContext(messages);
    mutable.content = [fauxText("SOURCE_END".padStart(70_000,"中"))];
    expect(JSON.stringify(await manager.transformContext(messages)).length).toBeLessThanOrEqual(55_000);
    expect(JSON.stringify(messages).includes("SOURCE_END")).toBe(true);
  });
  it("CHAT-20 does not count cancellation as failure and resets restored coverage after a model change",async () => {
    const f = fixture("pi-cancel-reset"),controller = new AbortController();
    const summary = vi.spyOn(f.models,"completeSimple").mockImplementationOnce(() => { controller.abort();return Promise.resolve(fauxAssistantMessage([fauxText("cancelled")])); })
      .mockResolvedValue(fauxAssistantMessage([fauxText("VALID_SUMMARY")]));
    const messages = history(),manager = createPiContextManager({ ...f,messagesMaxChars: 55_000,thinkingLevel: "high" });
    await manager.transformContext(messages,controller.signal);expect(manager.checkpoint()).toBeUndefined();
    await manager.transformContext(messages);expect(summary).toHaveBeenCalledTimes(2);
    const checkpoint = manager.checkpoint();if (checkpoint === undefined) throw new Error("Missing checkpoint");
    const changed = createPiContextManager({ ...f,model: { ...f.model,contextWindow: 1_000_000 },restored: checkpoint,messagesMaxChars: 55_000,thinkingLevel: "high" });
    await changed.transformContext(messages);expect(changed.checkpoint()?.count).toBe(1);expect(summary).toHaveBeenCalledTimes(3);
    messages[1] = { role: "user",content: "ROLLED_BACK_SOURCE".padEnd(4000,"x"),timestamp: 1 };
    summary.mockRejectedValueOnce(new Error("synthetic_failure"));await changed.transformContext(messages);
    expect(changed.checkpoint()).toBeUndefined();expect(JSON.stringify(messages)).toContain("ROLLED_BACK_SOURCE");
  });
  it("CHAT-20 keeps the previous checkpoint and its full source when the next summary expands history",async () => {
    const f = fixture("pi-expansion-keeps-checkpoint");
    vi.spyOn(f.models,"completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("summary ".repeat(3900))]));
    const messages: AgentMessage[] = [{ role: "user",content: "INITIAL_TASK",timestamp: 0 },...Array.from({ length: 8 },() => fauxAssistantMessage([fauxText("evidence".padEnd(4000,"x"))]))];
    const previous = { cut: 8,summary: "PREVIOUS_CHECKPOINT",count: 2,compactedMessages: 7,lastCompactedAt: "2026-11-11T00:00:00Z",messagesBefore: 9,tokensBefore: 8000,preservedIndices: [0],sourceFingerprint: transcriptFingerprint(messages,8) };
    messages.push({ role: "user",content: "CURRENT_TASK".padEnd(24_000,"中"),timestamp: 1 },...Array.from({ length: 3 },() => fauxAssistantMessage([fauxText("new evidence".padEnd(11_000,"中"))])));
    const original = JSON.stringify(messages);
    const manager = createPiContextManager({ ...f,messagesMaxChars: 55_000,thinkingLevel: "high",restored: previous });
    const request = await manager.transformContext(messages);
    expect(manager.checkpoint()).toEqual(previous);expect(JSON.stringify(request)).toContain("PREVIOUS_CHECKPOINT");
    expect(JSON.stringify(request).length).toBeLessThanOrEqual(55_000);expect(JSON.stringify(messages)).toBe(original);
  });
  it("CHAT-20/SUM-02 backs off a failed route across changed source with progressive cooldown", async () => {
    const f = fixture("pi-failure-backoff");
    const summary = vi.spyOn(f.models, "completeSimple").mockRejectedValue(new Error("synthetic_failure"));
    let now = 0;
    const manager = createPiContextManager({ ...f, messagesMaxChars: 55_000, thinkingLevel: "high", now: () => now });
    const messages = history();
    await manager.transformContext(messages);await manager.transformContext(messages);await manager.transformContext(messages);
    expect(summary).toHaveBeenCalledTimes(1);
    now = 30_000;await manager.transformContext(messages);
    expect(summary).toHaveBeenCalledTimes(2);
    messages[1] = { role: "user",content: "CHANGED_CANDIDATE".padEnd(4000,"z"),timestamp: 1 };
    await manager.transformContext(messages);
    expect(summary).toHaveBeenCalledTimes(2);
    now = 150_000; await manager.transformContext(messages);
    expect(summary).toHaveBeenCalledTimes(3);
  });
  it("CHAT-20 rejects an expanding summary and bounds the final serialized view including its notice", async () => {
    const f = fixture("pi-expanding-summary");
    vi.spyOn(f.models,"completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("摘要".repeat(15_900))]));
    const messages: AgentMessage[] = [{ role: "user",content: "TASK_ANCHOR".padEnd(24_000,"中"),timestamp: 0 },
      ...Array.from({ length: 3 },(_,i) => fauxAssistantMessage([fauxText(`EVIDENCE_${String(i)}`.padEnd(11_000,"中"))]))];
    const original = JSON.stringify(messages);
    const manager = createPiContextManager({ ...f,messagesMaxChars: 55_000,thinkingLevel: "high" });
    const request = await manager.transformContext(messages);
    expect(manager.checkpoint()).toBeUndefined();
    expect(JSON.stringify(request).length).toBeLessThanOrEqual(55_000);
    expect(JSON.stringify(request)).toContain("TASK_ANCHOR");
    expect(JSON.stringify(request)).toContain("joi context notice");
    expect(JSON.stringify(messages)).toBe(original);
  });
  it("does not summarize a short Pi history because its fixed system context exceeds the history trigger", async () => {
    const f = fixture("pi-fixed-context");
    const summary = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("Checkpoint")]));
    const manager = createPiContextManager({ ...f, messagesMaxChars: 1_000_000, thinkingLevel: "high" });
    const messages: AgentMessage[] = [
      { role: "system", content: "FIXED_POLICY".padEnd(140_000, "x"), timestamp: 0 },
      { role: "user", content: "MANDATORY_TASK", timestamp: 0 },
      fauxAssistantMessage([fauxText("Prior finding")]),
      { role: "user", content: "CURRENT_TASK", timestamp: 2 },
    ];
    expect(await manager.transformContext(messages)).toEqual(messages);
    expect(summary).not.toHaveBeenCalled();
    expect(manager.checkpoint()).toBeUndefined();
  });

  it("keeps fixed joi context out of the history trigger at turn and request boundaries", async () => {
    const f = fixture("joi-fixed-context");
    const summary = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("Checkpoint")]));
    f.faux.setResponses([fauxAssistantMessage([fauxText("continued")])]);
    let snapshot: JoiReasoningSessionSnapshot = { workbenchId: "wb", sessionId: "fixed", modelRevisionId: "mr", sourceRevisionId: "sr", systemPrompt: "POLICY", updatedAt: "2026-10-19T00:00:00Z", messages: [
      { role: "system", content: "FIXED_POLICY".padEnd(140_000, "x"), timestamp: 0 },
      { role: "user", content: "MANDATORY_TASK", timestamp: 0 },
      fauxAssistantMessage([fauxText("Prior finding")]),
      { role: "user", content: "Prior followup", timestamp: 2 },
      fauxAssistantMessage([fauxText("Prior answer")]),
    ] };
    const runtime = new PiReasoningRuntime({ ...f, thinkingLevel: "high", tools: [], sessionStore: { load: async () => snapshot, save: async value => { snapshot = value; } } });
    await runtime.startTurn({ workbenchId: "wb", sessionId: "fixed", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "FIXED_POLICY".padEnd(140_000, "x"), inputId: "input", turnId: "turn", prompt: "CURRENT_TASK", requiredContext: "REQUIRED_NOW" });
    expect(summary).not.toHaveBeenCalled();
    expect(snapshot.compaction).toBeUndefined();
    expect(JSON.stringify(snapshot.messages)).toContain("Prior finding");
  });

  it("checkpoints a long joi tool loop before its next provider request without changing the stored transcript", async () => {
    const f = fixture("joi-midflight-soft");
    const summary = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("Sources 0 through 5 checked; keep pending gap.")]));
    const requests: string[] = [];
    let callsAtFinalRequest = 0;
    f.faux.setResponses(Array.from({ length: 11 }, (_, index) => context => {
      requests.push(JSON.stringify(context.messages));
      if (index === 10) callsAtFinalRequest = summary.mock.calls.length;
      return index < 10 ? fauxAssistantMessage([fauxToolCall("work_read_result", { resultId: String(index) })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")]);
    }));
    let snapshot: JoiReasoningSessionSnapshot | undefined;
    const runtime = new PiReasoningRuntime({ ...f, thinkingLevel: "high", tools: [{
      name: "work_read_result", label: "Read", description: "Read evidence", parameters: Type.Object({ resultId: Type.String() }),
      execute: async (_id, raw) => ({ content: [{ type: "text", text: `PAGE_${(raw as { resultId: string }).resultId} `.padEnd(20_000, "x") }], details: {} }),
    }], sessionStore: { load: async () => null, save: async value => { snapshot = value; } } });
    await runtime.startTurn({ workbenchId: "wb", sessionId: "loop", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "POLICY", inputId: "input", turnId: "turn", prompt: "CURRENT_TASK", requiredContext: "REQUIRED_NOW" });
    expect(requests.at(-1)).toContain("joi session checkpoint");
    expect(requests.at(-1)).toContain("PAGE_9");
    expect(requests.at(-1)?.length).toBeLessThan(128_000);
    expect(JSON.stringify(snapshot?.archivedMessages)).toContain("PAGE_0");
    expect(JSON.stringify(snapshot?.messages)).toContain("CURRENT_TASK");
    expect(JSON.stringify(snapshot?.messages)).toContain("PAGE_9");
    // A request checkpoint must become the durable checkpoint without a second summary call.
    expect(summary).toHaveBeenCalledTimes(callsAtFinalRequest);
    expect(snapshot?.compaction?.count).toBeGreaterThan(0);
    expect(snapshot?.compaction?.coverage).toMatchObject({ coveredFrom: 0, transcriptId: "loop" });
    expect(snapshot?.compaction?.coverage?.coveredTo).toBe(snapshot?.archivedMessages?.length);
    const originalResults = [...(snapshot?.archivedMessages ?? []), ...(snapshot?.messages ?? [])]
      .filter(message => (message as { role?: string }).role === "toolResult");
    expect(originalResults).toHaveLength(10);
    for (let index = 0; index < 10; index += 1) expect(originalResults.filter(message => JSON.stringify(message).includes(`PAGE_${String(index)} `))).toHaveLength(1);
    const callsBeforeRestore = summary.mock.calls.length;
    f.faux.setResponses([fauxAssistantMessage([fauxText("recovered")])]);
    const restored = new PiReasoningRuntime({ ...f, thinkingLevel: "high", tools: [], sessionStore: {
      load: async () => snapshot ?? null, save: async value => { snapshot = value; },
    } });
    await restored.startTurn({ workbenchId: "wb", sessionId: "loop", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "POLICY", inputId: "input", turnId: "restore", prompt: "continue" });
    expect(summary).toHaveBeenCalledTimes(callsBeforeRestore);
  });
  it("keeps a former task anchor until a successful checkpoint explicitly summarizes it", async () => {
    const f = fixture("pi-released-anchor");
    const summary = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("summary")]));
    const messages: AgentMessage[] = [{ role: "user", content: "INITIAL_TASK", timestamp: 0 },
      { role: "user", content: "TASK_A", timestamp: 1 },
      ...Array.from({ length: 50 }, () => fauxAssistantMessage([fauxText("evidence".padEnd(4000, "x"))]))];
    let now = 0;
    const manager = createPiContextManager({ ...f, messagesMaxChars: 1_000_000, thinkingLevel: "high",now: () => now });
    await manager.transformContext(messages);
    await new Promise<void>(resolve => { setImmediate(resolve); }); manager.collect(messages);
    messages.push({ role: "user", content: "TASK_B", timestamp: 2 },
      ...Array.from({ length: 50 }, () => fauxAssistantMessage([fauxText("new evidence".padEnd(4000, "y"))])));
    summary.mockRejectedValueOnce(new Error("summary_failed"));
    const failedRequest = await manager.transformContext(messages);
    await new Promise<void>(resolve => { setImmediate(resolve); }); manager.collect(messages);
    expect(JSON.stringify(failedRequest)).toContain("TASK_A");
    expect(JSON.stringify(failedRequest)).toContain("TASK_B");
    now = 30_000;
    await manager.transformContext(messages);
    await new Promise<void>(resolve => { setImmediate(resolve); }); manager.collect(messages);
    expect(JSON.stringify(summary.mock.calls.at(-1))).toContain("TASK_A");
    expect(manager.checkpoint()?.count).toBe(2);
  });
  it("rejects a restored checkpoint whose covered source belongs to a different transcript", async () => {
    const f = fixture("pi-coverage-identity");
    vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("foreign summary")]));
    const manager = createPiContextManager({ ...f, messagesMaxChars: 1_000_000, thinkingLevel: "high" });
    const original = history();
    await manager.transformContext(original);
    await new Promise<void>(resolve => { setImmediate(resolve); }); manager.collect(original);
    const checkpoint = manager.checkpoint();
    expect(checkpoint).toBeDefined();
    const other = history();
    other[1] = { role: "user", content: "DIFFERENT_SOURCE", timestamp: 1 };
    const restored = createPiContextManager({ ...f, messagesMaxChars: 1_000_000, thinkingLevel: "high", ...(checkpoint === undefined ? {} : { restored: checkpoint }) });
    await restored.transformContext(other);
    await new Promise<void>(resolve => { setImmediate(resolve); }); restored.collect(other);
    expect(restored.checkpoint()?.sourceFingerprint).not.toBe(checkpoint?.sourceFingerprint);
    expect(restored.checkpoint()?.count).toBe(1);
  });
  it.each(["", "   \n"])("retains source coverage when the summary contains no usable text (%j)", async content => {
    const f = fixture("pi-empty-summary");
    vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText(content)]));
    const manager = createPiContextManager({ ...f, messagesMaxChars: 1_000_000, thinkingLevel: "high" });
    const request = await manager.transformContext(history());
    expect(manager.checkpoint()).toBeUndefined();
    expect(JSON.stringify(request)).toBe(JSON.stringify(history()));
  });
  it("rolls back both archived and live history after a checkpointed replay-safe turn", async () => {
    const f = fixture("joi-checkpoint-rollback");
    const summary = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("summary")]));
    f.faux.setResponses(Array.from({ length: 11 }, (_, index) => index < 10
      ? fauxAssistantMessage([fauxToolCall("work_read_result", { resultId: String(index) })], { stopReason: "toolUse" })
      : fauxAssistantMessage([fauxText("done")])));
    let snapshot: JoiReasoningSessionSnapshot | undefined;
    const runtime = new PiReasoningRuntime({ ...f, thinkingLevel: "high", tools: [{
      name: "work_read_result", label: "Read", description: "Read evidence", parameters: Type.Object({ resultId: Type.String() }),
      execute: async () => ({ content: [{ type: "text", text: "TURN_EVIDENCE".padEnd(20_000, "x") }], details: {} }),
    }], sessionStore: { load: async () => null, save: async value => { snapshot = structuredClone(value); } } });
    await runtime.startTurn({ workbenchId: "wb", sessionId: "rollback", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "POLICY", inputId: "input", turnId: "turn", prompt: "TASK" });
    expect(snapshot?.archivedMessages?.length).toBeGreaterThan(0);
    const calls = summary.mock.calls.length;
    expect(await runtime.rollbackTurn("rollback", "turn")).toBe(true);
    expect(snapshot?.archivedMessages).toEqual([]);
    expect(snapshot?.compaction).toBeUndefined();
    expect(JSON.stringify(snapshot?.messages)).not.toContain("TURN_EVIDENCE");
    expect(summary).toHaveBeenCalledTimes(calls);
  });
  it("preserves the current task as well as the initial task when a request checkpoint covers intervening history", async () => {
    const f = fixture("pi-task-anchors");
    vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("summary")]));
    const messages: AgentMessage[] = [{ role: "user", content: "MANDATORY_TASK", timestamp: 0 },
      ...Array.from({ length: 50 }, (_, index) => fauxAssistantMessage([fauxText(`evidence-${String(index)} `.padEnd(4000, "x"))]))];
    messages.splice(10, 0, { role: "user", content: "CURRENT_REQUIRED_TASK", timestamp: 99 });
    const manager = createPiContextManager({ ...f, messagesMaxChars: 1_000_000, thinkingLevel: "high" });
    const request = await manager.transformContext(messages);
    expect(JSON.stringify(request)).toContain("MANDATORY_TASK");
    expect(JSON.stringify(request)).toContain("CURRENT_REQUIRED_TASK");
  });
  it("pages one stable history view while new messages arrive and serializes each source only once", async () => {
    let serialized = 0;
    const source = Array.from({ length: 1000 }, (_, index) => ({ toJSON: () => { serialized += 1; return { evidence: String(index).padEnd(100, "x") }; } }));
    const expected = JSON.stringify(source);
    serialized = 0;
    const tool = createContextHistoryTool(() => source);
    let offset = 0;
    let cursor: string | undefined;
    let body = "";
    do {
      const result = await tool.execute("read", { offset, cursor, limit: 8000 });
      const page = JSON.parse((result.content[0] as { text: string }).text) as { body: string; cursor: string; nextOffset: number | null };
      expect(page.cursor).toEqual(cursor ?? expect.any(String));
      cursor = page.cursor;
      body += page.body;
      if (offset === 0) source.push({ toJSON: () => ({ evidence: "NEW_ARRIVAL" }) });
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (offset > 0);
    expect(body).toBe(expected);
    expect(serialized).toBe(1000);
  });
  it("retains the entire latest tool exchange even when it exceeds the soft request bound", () => {
    const call = fauxAssistantMessage([{ type: "toolCall", id: "latest-call", name: "work_read_result", arguments: { resultId: "r" } }], { stopReason: "toolUse" });
    const result: AgentMessage = { role: "toolResult", toolCallId: "latest-call", toolName: "work_read_result", content: [{ type: "text", text: "COMPLETE_LATEST_END".padStart(140_000, "x") }], isError: false, timestamp: 2 };
    const messages = [...history(), call, result];
    const request = boundRequestByChars(messages, 64_000);
    expect(request).toContain(call);
    expect(request).toContain(result);
    expect(JSON.stringify(request)).toContain("MANDATORY_TASK");
  });
  it("pages archived private context through a closure without accepting another session", async () => {
    const source = history();
    const tool = createContextHistoryTool(() => source);
    let offset = 0;
    let body = "";
    do {
      const result = await tool.execute("read", { offset, sessionId: "foreign" });
      const page = JSON.parse((result.content[0] as { text: string }).text) as { body: string; nextOffset: number | null };
      expect(page.body.length).toBeLessThanOrEqual(8000);
      body += page.body;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (offset > 0);
    expect(body).toBe(JSON.stringify(source));
  });
  it("keeps a failed joi summary's old checkpoint and its uncovered source history", async () => {
    const f = fixture("joi-summary-failure");
    const previous = { compactedMessages: 8, count: 1, lastCompactedAt: "2026-10-18T00:00:00Z", summary: "PREVIOUS_CONCLUSION_END" };
    let snapshot: JoiReasoningSessionSnapshot = { workbenchId: "wb", sessionId: "failed", modelRevisionId: "mr", sourceRevisionId: "sr", systemPrompt: "POLICY", updatedAt: "2026-10-19T00:00:00Z", compaction: previous, messages: history() };
    vi.spyOn(f.models, "completeSimple").mockRejectedValue(new Error("summary_failed"));
    f.faux.setResponses([fauxAssistantMessage([fauxText("continued")])]);
    const runtime = new PiReasoningRuntime({ ...f, compaction: { maxMessages: 10, keepRecentMessages: 2 }, thinkingLevel: "high", tools: [], sessionStore: {
      load: async () => snapshot, save: async value => { snapshot = value; },
    } });
    await runtime.startTurn({ workbenchId: "wb", sessionId: "failed", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "POLICY", inputId: "input", turnId: "turn", prompt: "continue" });
    expect(snapshot.compaction).toEqual(previous);
    expect(JSON.stringify(snapshot.messages)).toContain("evidence-0");
    expect(snapshot.messages.length).toBeGreaterThan(50);
  });
  it("SUM-05/07 compacts Pi incrementally from its 128K soft trigger toward 64K", async () => {
    const f = fixture("pi-soft-budget");
    vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("checkpoint with references and unresolved gaps")]));
    const manager = createPiContextManager({ ...f, messagesMaxChars: 1_000_000, thinkingLevel: "high" });
    const messages = history();
    let request: AgentMessage[] = [];
    for (let index = 0; index < 6; index += 1) {
      request = await manager.transformContext(messages);
      await new Promise<void>(resolve => { setImmediate(resolve); }); manager.collect(messages);
    }
    expect(manager.checkpoint()?.count).toBeGreaterThan(1);
    expect(JSON.stringify(request).length).toBeLessThanOrEqual(64_000);
    expect(JSON.stringify(request)).toContain("MANDATORY_TASK");
    expect(messages).toHaveLength(51);
  });

  it("compacts joi on the same independent budget and preserves the current requirements", async () => {
    const f = fixture("joi-soft-budget");
    vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("checkpoint with references and unresolved gaps")]));
    f.faux.setResponses(Array.from({ length: 4 }, () => context => {
      expect(JSON.stringify(context)).toContain("REQUIRED_NOW"); return fauxAssistantMessage([fauxText("continued")]);
    }));
    let snapshot: JoiReasoningSessionSnapshot = { workbenchId: "wb", sessionId: "session", modelRevisionId: "mr", sourceRevisionId: "sr", systemPrompt: "POLICY", updatedAt: "2026-10-19T00:00:00Z", messages: history() };
    const runtime = new PiReasoningRuntime({ ...f, thinkingLevel: "high", tools: [], sessionStore: {
      load: async () => snapshot, save: async value => { snapshot = value; },
    } });
    for (let index = 0; index < 4; index += 1) await runtime.startTurn({ workbenchId: "wb", sessionId: "session", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "POLICY", inputId: "input", turnId: `turn-${String(index)}`, prompt: "continue", requiredContext: "REQUIRED_NOW" });
    expect(snapshot.compaction?.count).toBeGreaterThan(1);
    expect(JSON.stringify(snapshot.messages).length).toBeLessThanOrEqual(64_000);
  });
});
