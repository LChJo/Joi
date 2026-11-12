/* Provider doubles exercise the pinned SDK without external requests. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeSegment, SummaryRetryGuard, type SummaryGenerationDiagnostic } from "../../src/main/infrastructure/pi/pi-compaction.js";
import { createPiContextManager } from "../../src/main/infrastructure/pi/pi-context-manager.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";

function fixture() {
  const faux = fauxProvider({ provider: "summary-contract", models: [{ id: "summary", contextWindow: 1_000_000, maxTokens: 32_768 }] });
  const models = createModels(); models.setProvider(faux.provider);
  return { faux, models, model: faux.getModel() };
}
function history(): AgentMessage[] {
  return [{ role: "user", content: "INITIAL_TASK", timestamp: 0 },
    ...Array.from({ length: 50 }, (_, index) => fauxAssistantMessage([fauxText(`SOURCE_${String(index)}`.padEnd(4000, "中"))])),
    { role: "user", content: "CURRENT_TASK", timestamp: 1 }];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("SUM-01/03/05/11 summary optimization", () => {
  it.each([
    ["length", "summary_truncated"], ["aborted", "summary_canceled"],
    ["pending", "summary_incomplete"], ["deferred", "summary_incomplete"], ["error", "summary_provider_error"],
    ["toolUse", "summary_tool_call"],
  ] as const)("rejects %s even when it carries usable-looking text", async (stopReason, reasonCode) => {
    const f = fixture();
    vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("PARTIAL_PRIVATE_TEXT")], { stopReason }));
    expect(await summarizeSegment({ ...f, segment: history().slice(0, 3), reserveTokens: 8000, thinkingLevel: "high" }))
      .toMatchObject({ ok: false, reasonCode });
  });
  it("rejects a tool call hidden in a normally stopped response", async () => {
    const f = fixture();
    vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("summary"), fauxToolCall("read", {})], { stopReason: "stop" }));
    expect(await summarizeSegment({ ...f, segment: history().slice(0, 3), reserveTokens: 8000, thinkingLevel: "high" }))
      .toMatchObject({ ok: false, reasonCode: "summary_tool_call" });
  });
  it("uses the model output capacity independently of the 8000 token context reserve", async () => {
    const f = fixture();
    const request = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("summary")]));
    expect(await summarizeSegment({ ...f, segment: history().slice(0, 3), reserveTokens: 8000, thinkingLevel: "high" })).toMatchObject({ ok: true });
    expect(request.mock.calls[0]?.[2]?.maxTokens).toBe(32_768);
  });
  it("returns the intact soft-budget history before a slow summary completes", async () => {
    vi.useFakeTimers();
    const f = fixture(), pending = deferred<AssistantMessage>();
    const request = vi.spyOn(f.models, "completeSimple").mockReturnValue(pending.promise);
    const manager = createPiContextManager({ ...f, messagesMaxChars: 900_000, thinkingLevel: "high" });
    const messages = history(), original = JSON.stringify(messages);
    let finished = false;
    const foreground = manager.transformContext(messages).then(value => { finished = true; return value; });
    await vi.advanceTimersByTimeAsync(0);
    const returnedBeforeSummary = finished;
    pending.resolve(fauxAssistantMessage([fauxText("summary")]));
    await vi.advanceTimersByTimeAsync(0);
    const outgoing = await foreground;
    expect(returnedBeforeSummary).toBe(true);
    expect(JSON.stringify(outgoing)).toBe(original);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("backs off one failing route across twenty changed candidates", async () => {
    const f = fixture();
    const request = vi.spyOn(f.models, "completeSimple").mockRejectedValue(new Error("PRIVATE_FAILURE"));
    const manager = createPiContextManager({ ...f, messagesMaxChars: 55_000, thinkingLevel: "high", now: () => 1000 });
    const messages = history();
    for (let index = 0; index < 20; index += 1) {
      messages.push(fauxAssistantMessage([fauxText(`NEW_${String(index)}`)]));
      await manager.transformContext(messages);
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect(manager.checkpoint()).toBeUndefined();
    expect(JSON.stringify(messages)).toContain("SOURCE_0");
  });
  it("does not block a primary Joi turn on a soft summary and drains its cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture(), pending = deferred<AssistantMessage>();
    f.faux.setResponses([fauxAssistantMessage([fauxText("continued")])]);
    const request = vi.spyOn(f.models, "completeSimple").mockReturnValue(pending.promise);
    let snapshot: JoiReasoningSessionSnapshot = { sessionId: "primary", workbenchId: "wb", modelRevisionId: "mr", sourceRevisionId: "sr", systemPrompt: "POLICY", messages: history(), updatedAt: "now" };
    const runtime = new PiReasoningRuntime({ ...f, thinkingLevel: "high", tools: [], sessionStore: {
      load: async () => snapshot, save: async value => { snapshot = value; },
    } });
    let finished = false;
    const turn = runtime.startTurn({ sessionId: "primary", workbenchId: "wb", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "POLICY", inputId: "i", turnId: "t", prompt: "continue", requiredContext: "CURRENT_REQUIREMENT" }).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(0);
    const returnedBeforeSummary = finished;
    pending.resolve(fauxAssistantMessage([fauxText("summary")]));
    await vi.advanceTimersByTimeAsync(0);
    await turn;
    expect(returnedBeforeSummary).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    expect(snapshot.compaction).toBeUndefined();
    expect(JSON.stringify(snapshot.messages)).toContain("SOURCE_0");
  });
  it("limits hard-budget foreground waiting to five seconds and keeps the background single flight", async () => {
    vi.useFakeTimers();
    const f = fixture(), pending = deferred<AssistantMessage>();
    const request = vi.spyOn(f.models, "completeSimple").mockReturnValue(pending.promise);
    const boundaries: { stage: string; durationMs: number; outcome: string }[] = [];
    const messages = history(), manager = createPiContextManager({ ...f, messagesMaxChars: 55_000, thinkingLevel: "high", onDiagnostic: event => {
      if (event.type === "joi.context.summary_boundary") boundaries.push(event);
    } });
    let returned = false;
    const foreground = manager.transformContext(messages).then(value => { returned = true; return value; });
    await vi.advanceTimersByTimeAsync(4999); expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(returned).toBe(true);
    expect(JSON.stringify(await foreground)).toContain("joi context notice");
    const next = manager.transformContext([...messages, fauxAssistantMessage([fauxText("APPENDED")])]);
    await vi.advanceTimersByTimeAsync(5000); await next;
    expect(request).toHaveBeenCalledTimes(1);
    await manager.close(messages, true);
    expect(manager.checkpoint()).toBeUndefined();
    expect(boundaries.filter(event => event.stage === "hard_wait")).toEqual([
      expect.objectContaining({ durationMs: 5000, outcome: "deadline" }), expect.objectContaining({ durationMs: 5000, outcome: "deadline" }),
    ]);
    expect(boundaries.at(-1)).toMatchObject({ stage: "cleanup", outcome: "canceled" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("persists progressive cooldown independently of source candidates and cancellation", async () => {
    let now = 1000;
    const f = fixture(), request = vi.spyOn(f.models, "completeSimple").mockRejectedValue(new Error("failure"));
    const messages = history(), manager = createPiContextManager({ ...f, routeRevision: "route-1", messagesMaxChars: 55_000, thinkingLevel: "high", now: () => now });
    await manager.transformContext(messages);
    const firstRetry = manager.retryState(); if (firstRetry === undefined) throw new Error("Missing retry state");
    const restored = createPiContextManager({ ...f, routeRevision: "route-1", messagesMaxChars: 55_000, thinkingLevel: "high", now: () => now, retryState: firstRetry });
    await restored.close(messages, true);
    messages.push(fauxAssistantMessage([fauxText("NEW_SOURCE")]));
    await restored.transformContext(messages); expect(request).toHaveBeenCalledTimes(1);
    now += 30_000;
    await restored.transformContext(messages);
    expect(restored.retryState()).toMatchObject({ failures: 2, until: now + 120_000 });
    now += 120_000;
    await restored.transformContext(messages);
    expect(restored.retryState()).toMatchObject({ failures: 3, until: now + 300_000 });
    const lastRetry = restored.retryState(); if (lastRetry === undefined) throw new Error("Missing retry state");
    const changed = createPiContextManager({ ...f, routeRevision: "route-2", messagesMaxChars: 55_000, thinkingLevel: "high", now: () => now, retryState: lastRetry });
    await changed.transformContext(messages); expect(request).toHaveBeenCalledTimes(4);
    const guard = new SummaryRetryGuard(() => now, restored.retryState());
    expect(guard.snapshot()).toEqual(restored.retryState());
  });
  it("rejects a completed background result if its frozen prefix was edited", async () => {
    vi.useFakeTimers();
    const f = fixture(), pending = deferred<AssistantMessage>();
    vi.spyOn(f.models, "completeSimple").mockReturnValue(pending.promise);
    const messages = history(), manager = createPiContextManager({ ...f, messagesMaxChars: 900_000, thinkingLevel: "high" });
    await manager.transformContext(messages);
    messages[1] = fauxAssistantMessage([fauxText("EDITED_PREFIX")]);
    pending.resolve(fauxAssistantMessage([fauxText("STALE_SUMMARY")]));
    await vi.advanceTimersByTimeAsync(0);
    manager.collect(messages);
    expect(manager.checkpoint()).toBeUndefined();
    expect(manager.retryState()).toBeUndefined();
    await manager.close(messages);
  });
  it("advances a 500K backlog in bounded frozen batches without resummarizing covered source", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("SUMMARY_WITH_REFERENCES")]));
    const messages = [{ role: "user" as const, content: "INITIAL_TASK", timestamp: 0 },
      ...Array.from({ length: 125 }, (_, index) => fauxAssistantMessage([fauxText(`UNIQUE_SOURCE_${String(index)}_END`.padEnd(4000, "中"))])),
      { role: "user" as const, content: "CURRENT_TASK", timestamp: 1 }];
    const original = JSON.stringify(messages), sizes: number[] = [];
    const manager = createPiContextManager({ ...f, messagesMaxChars: 900_000, thinkingLevel: "high", onDiagnostic: event => {
      if (event.type === "joi.partner.context_summary_started") sizes.push(event.candidateChars);
    } });
    let outgoing: AgentMessage[] = [];
    for (let index = 0; index < 12; index += 1) {
      outgoing = await manager.transformContext(messages);
      await vi.advanceTimersByTimeAsync(0);
      manager.collect(messages);
    }
    expect(request.mock.calls.length).toBeGreaterThan(5);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64_000);
    expect(manager.checkpoint()?.cut).toBeGreaterThan(100);
    expect(JSON.stringify(outgoing).length).toBeLessThan(128_000);
    expect(JSON.stringify(outgoing)).toContain("CURRENT_TASK");
    expect(JSON.stringify(request.mock.calls.slice(1))).toContain("previous-summary");
    for (let index = 0; index < 100; index += 1) {
      expect(request.mock.calls.filter(call => JSON.stringify(call[1]).includes(`UNIQUE_SOURCE_${String(index)}_END`))).toHaveLength(1);
    }
    expect(JSON.stringify(messages)).toBe(original);
    await manager.close(messages);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("replays a 403 second failing route with at most three attempts and one flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const f = fixture();
    let active = 0, peak = 0;
    const request = vi.spyOn(f.models, "completeSimple").mockImplementation(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => { setTimeout(resolve, 40_000); }); active -= 1;
      return fauxAssistantMessage([fauxText("PARTIAL")], { stopReason: "length" });
    });
    const messages = history(), manager = createPiContextManager({ ...f, messagesMaxChars: 900_000, thinkingLevel: "high" });
    for (let elapsed = 0; elapsed < 403_000; elapsed += 5000) {
      messages.push(fauxAssistantMessage([fauxText(`TAIL_${String(elapsed)}`)]));
      await manager.transformContext(messages);
      await vi.advanceTimersByTimeAsync(Math.min(5000, 403_000 - elapsed));
    }
    expect(request).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
    expect(manager.checkpoint()).toBeUndefined();
    expect(manager.retryState()?.failures).toBe(3);
    await manager.close(messages, true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("times out a nonresponsive provider and emits only safe outcome and budget numbers", async () => {
    vi.useFakeTimers();
    const f = fixture(), events: SummaryGenerationDiagnostic[] = [];
    vi.spyOn(f.models, "completeSimple").mockReturnValue(new Promise(() => undefined));
    const result = summarizeSegment({ ...f, segment: history().slice(0, 3), reserveTokens: 8000, thinkingLevel: "high", onDiagnostic: event => { events.push(event); } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ ok: false, reasonCode: "summary_timed_out" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reasonCode: "summary_timed_out", maxOutputTokens: 32_768 });
    expect(JSON.stringify(events)).not.toContain("INITIAL_TASK");
    expect(JSON.stringify(events)).not.toContain("SOURCE_");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("clamps output to the remaining full summary window including the previous checkpoint", async () => {
    const f = fixture();
    const request = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("summary")]));
    await summarizeSegment({ ...f, model: { ...f.model, contextWindow: 16_000 }, previousSummary: "PREVIOUS".padEnd(4000, "中"), segment: history().slice(0, 3), reserveTokens: 1000, thinkingLevel: "high" });
    const call = request.mock.calls[0];
    expect(call).toBeDefined();
    const maxTokens = call?.[2]?.maxTokens ?? 0;
    expect(maxTokens).toBeGreaterThan(0);
    expect(maxTokens + JSON.stringify(call?.[1]).length).toBeLessThan(16_000);
    expect(maxTokens).toBeLessThan(8000);
  });
  it("uses the lowest supported thinking level when the pinned model cannot disable it", async () => {
    const f = fixture();
    const request = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("summary")]));
    await summarizeSegment({ ...f, model: { ...f.model, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low" } },
      segment: history().slice(0, 3), reserveTokens: 8000, thinkingLevel: "high" });
    expect(request.mock.calls[0]?.[2]?.reasoning).toBe("low");
  });
  it("keeps the established low-effort floor for a route that requires thinking", async () => {
    const f = fixture();
    const request = vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("summary")]));
    await summarizeSegment({ ...f, model: { ...f.model, reasoning: true, baseUrl: "https://token-plan.example.invalid/v1" },
      segment: history().slice(0, 3), reserveTokens: 8000, thinkingLevel: "high" });
    expect(request.mock.calls[0]?.[2]?.reasoning).toBe("low");
  });
});
