import { trackPiModels as instrumentPiModels, trackPiStream } from "../../src/main/infrastructure/pi/pi-usage.js";
import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { beginUsage, normalizeClaudeModelUsage as normalizeClaudeUsage, normalizeCodexUsage, normalizePiUsage, safeProviderLabel } from "../../src/main/infrastructure/usage/sdk-usage.js";
import type { UsageContext, UsageObservation, UsageRecorder } from "../../src/main/application/ports/usage.js";

function recorder() {
  const observations: UsageObservation[] = [];
  const contexts: UsageContext[] = [];
  const finish = vi.fn();
  const usage: UsageRecorder = { begin(context) { contexts.push(context); return { id: "id", record: (row) => observations.push(row), finish }; } };
  return { usage, observations, contexts, finish };
}
const message = (stopReason = "stop") => ({ role: "assistant", content: [], model: "model", stopReason, usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 3 } }) as unknown as AssistantMessage;

describe("SDK usage normalization (AC-STATS-01)", () => {
  it("counts cache exactly once and keeps reasoning inside output", () => {
    expect(normalizePiUsage(message().usage)).toEqual({ input: 33, output: 5, cacheRead: 20, cacheWrite: 3, reasoning: null });
    expect(normalizeCodexUsage({ input_tokens: 33, cached_input_tokens: 20, output_tokens: 15, output_tokens_details: { reasoning_tokens: 10 } })).toEqual({ input: 33, output: 15, cacheRead: 20, cacheWrite: null, reasoning: 10 });
    expect(normalizeClaudeUsage({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 20, cacheCreationInputTokens: 3 })).toEqual({ input: 33, output: 5, cacheRead: 20, cacheWrite: 3, reasoning: null });
  });
  it.each([undefined, null, {}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, { input: -1, output: 2 }, { input: NaN, output: 2 }])("keeps absent or invalid Pi usage unknown: %j", (value) => expect(normalizePiUsage(value)).toBeNull());
  it("records complete calls independently and records failed responses before returning them", async () => {
    const sink = recorder();
    const models = { completeSimple: vi.fn().mockResolvedValueOnce(message()).mockResolvedValueOnce(message("error")) } as unknown as Models;
    const wrapped = instrumentPiModels(models, sink.usage, () => ({ engine: "pi", purpose: "summary", workbenchId: "wb" }));
    await wrapped.completeSimple({ id: "model" } as never, { messages: [] });
    await wrapped.completeSimple({ id: "model" } as never, { messages: [] });
    expect(sink.contexts).toHaveLength(2);
    expect(sink.observations).toHaveLength(2);
    expect(sink.finish.mock.calls).toEqual([["completed"], ["failed"]]);
  });
  it("captures stream partial usage on canceled results without double recording", async () => {
    const sink = recorder();
    const stream = createAssistantMessageEventStream();
    const models = { streamSimple: () => stream } as unknown as Models;
    const wrapped = instrumentPiModels(models, sink.usage, () => ({ engine: "pi", purpose: "partner" }));
    const output = wrapped.streamSimple({ id: "model" } as never, { messages: [] });
    const result = message("aborted");
    stream.push({ type: "error", reason: "aborted", error: result });
    expect(await output.result()).toBe(result);
    expect(sink.observations).toHaveLength(1);
    expect(sink.finish).toHaveBeenCalledWith("canceled");
  });
  it("keeps thrown calls and telemetry faults from masking the original result", async () => {
    const sink = recorder();
    const failure = new Error("transport");
    const models = { completeSimple: vi.fn().mockRejectedValue(failure) } as unknown as Models;
    const wrapped = instrumentPiModels(models, sink.usage, () => ({ engine: "pi", purpose: "probe" }));
    await expect(wrapped.completeSimple({ id: "model" } as never, { messages: [] })).rejects.toBe(failure);
    expect(sink.finish).toHaveBeenCalledWith("failed");
    const unsafe: UsageRecorder = { begin() { throw new Error("storage"); } };
    await expect(instrumentPiModels(models, unsafe, () => ({ engine: "pi", purpose: "probe" })).completeSimple({ id: "model" } as never, { messages: [] })).rejects.toBe(failure);
    expect(instrumentPiModels(models, undefined, () => ({ engine: "pi", purpose: "probe" }))).toBe(models);
  });

  it.each([undefined, null, {}, [], { input_tokens: 1, output_tokens: -1 }, { input_tokens: 1, output_tokens: 1, reasoning_output_tokens: NaN }])("rejects malformed Codex snapshots: %j", (value) => expect(normalizeCodexUsage(value)).toBeNull());
  it.each([undefined, null, {}, [], { inputTokens: 1, outputTokens: -1 }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, cacheReadInputTokens: 1, cacheCreationInputTokens: 0 }])("rejects malformed Claude snapshots: %j", (value) => expect(normalizeClaudeUsage(value)).toBeNull());
  it("handles overflow, unreported subsets and invalid reasoning conservatively", () => {
    expect(normalizePiUsage({ input: Number.MAX_SAFE_INTEGER, output: 1, cacheRead: 1, cacheWrite: 0 })).toBeNull();
    expect(normalizePiUsage({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: -1 })).toBeNull();
    expect(normalizeCodexUsage({ input_tokens: 1, output_tokens: 2 })).toEqual({ input: 1, output: 2, cacheRead: null, cacheWrite: null, reasoning: null });
    expect(safeProviderLabel("https://private.test", "Pi")).toBe("Pi");
    expect(safeProviderLabel("", "Pi")).toBe("Pi");
    expect(safeProviderLabel("x".repeat(121), "Pi")).toBe("Pi");
  });
  it("ignores observation failures and duplicate completion after finishing", () => {
    const record = vi.fn(() => { throw new Error("storage"); });
    const finish = vi.fn(() => { throw new Error("storage"); });
    const session = beginUsage({ begin: () => ({ id: "id", record, finish }) }, { engine: "pi", purpose: "probe" });
    session.record({ key: "x", tokens: null }); session.finish("failed"); session.finish("completed"); session.record({ key: "y", tokens: null });
    expect(record).toHaveBeenCalledTimes(1); expect(finish).toHaveBeenCalledTimes(1);
    const disabled = beginUsage(undefined, { engine: "pi", purpose: "probe" }); disabled.record({ key: "x", tokens: null }); disabled.finish("failed");
  });
  it("binds passthrough methods and attributes rejected and synchronously throwing streams", async () => {
    const sink = recorder(); const controller = new AbortController(); controller.abort();
    const models = { value: 7, getValue() { return this.value; }, streamSimple: vi.fn().mockReturnValueOnce({ result: () => Promise.reject(new Error("stream")) }).mockImplementationOnce(() => { throw new Error("start"); }) };
    const wrapped = instrumentPiModels(models as unknown as Models, sink.usage, () => ({ engine: "pi", purpose: "partner" }));
    expect((wrapped as unknown as typeof models).getValue()).toBe(7);
    trackPiStream(models as unknown as Models, sink.usage, () => ({ engine: "pi", purpose: "partner" }))({ id: "model" } as never, { messages: [] }, { signal: controller.signal });
    await Promise.resolve();
    expect(sink.finish).toHaveBeenCalledWith("canceled");
    expect(() => wrapped.streamSimple({ id: "model" } as never, { messages: [] })).toThrow("start");
    expect(sink.finish).toHaveBeenCalledWith("failed");
  });
});
