import { trackPiModels } from "../../src/main/infrastructure/pi/pi-usage.js";
import { BACKGROUND_CONTEXT, generateSummary, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

import type { UsageContext, UsageObservation, UsageRecorder, UsageSession } from "../../src/main/application/ports/usage.js";
import {
  normalizeClaudeModelUsage,
  normalizeCodexUsage,
  normalizePiUsage,
} from "../../src/main/infrastructure/usage/sdk-usage.js";

class RecordingUsageRecorder implements UsageRecorder {
  readonly sessions: { context: UsageContext; observations: UsageObservation[]; statuses: string[] }[] = [];

  begin(context: UsageContext): UsageSession {
    const captured = { context, observations: [] as UsageObservation[], statuses: [] as string[] };
    this.sessions.push(captured);
    return {
      id: `usage-${String(this.sessions.length)}`,
      record: (observation) => { captured.observations.push(observation); },
      finish: (status) => { captured.statuses.push(status); },
    };
  }
}

const piCost = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 };

describe("SDK usage normalization", () => {
  it("adds Pi cache tokens to input once and preserves reasoning as an output subset", () => {
    expect(normalizePiUsage({
      input: 11, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: 4,
      totalTokens: 26, cost: piCost,
    })).toEqual({ input: 19, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: 4 });

    expect(normalizePiUsage({
      input: 11, output: 7, cacheRead: 5, cacheWrite: 3,
      totalTokens: 26, cost: piCost,
    })).toEqual({ input: 19, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: null });
  });

  it("treats Pi all-zero placeholders and partial or invalid usage as unknown", () => {
    expect(normalizePiUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: piCost })).toBeNull();
    expect(normalizePiUsage({ input: 2, output: 1, cacheRead: 0 })).toBeNull();
    expect(normalizePiUsage({ input: -1, output: 1, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(normalizePiUsage(undefined)).toBeNull();
  });

  it("keeps Codex inclusive totals from double-counting cache and reasoning", () => {
    expect(normalizeCodexUsage({
      input_tokens: 20,
      cached_input_tokens: 6,
      cache_write_input_tokens: 2,
      output_tokens: 9,
      reasoning_output_tokens: 4,
    })).toEqual({ input: 20, output: 9, cacheRead: 6, cacheWrite: 2, reasoning: 4 });
  });

  it("adds Claude cache subsets to the non-cache input count", () => {
    expect(normalizeClaudeModelUsage({
      inputTokens: 10,
      outputTokens: 8,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 3,
    })).toEqual({ input: 20, output: 8, cacheRead: 7, cacheWrite: 3, reasoning: null });
    expect(normalizeClaudeModelUsage({ inputTokens: 10, outputTokens: 8 })).toBeNull();
  });
});

describe("Pi usage model wrapper", () => {
  it("creates one invocation per provider request and does not double-wrap completeSimple", async () => {
    const faux = fauxProvider({ provider: "usage-provider" });
    const first = fauxAssistantMessage("first");
    first.usage = { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: 3, totalTokens: 17, cost: piCost };
    const second = fauxAssistantMessage("second");
    second.usage = { input: 8, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: piCost };
    faux.setResponses([first, second]);
    const models = createModels();
    models.setProvider(faux.provider);
    const usage = new RecordingUsageRecorder();
    const tracked = trackPiModels(models, usage, () => ({
      engine: "pi", purpose: "partner", workbenchId: "wb-1", workId: "work-1",
      partnerId: "partner-1", sourceId: "source-1", sourceName: "Pi", modelId: "model-1",
    }));

    await tracked.completeSimple(faux.getModel(), { messages: [] });
    await tracked.completeSimple(faux.getModel(), { messages: [] });

    expect(usage.sessions).toHaveLength(2);
    expect(usage.sessions.map((session) => session.observations)).toEqual([
      [expect.objectContaining({ key: "result", modelId: "model-1", sourceId: "source-1", sourceName: "Pi" })],
      [expect.objectContaining({ key: "result", modelId: "model-1", sourceId: "source-1", sourceName: "Pi" })],
    ]);
    expect(usage.sessions.map((session) => session.statuses)).toEqual([["completed"], ["completed"]]);
  });

  it("records compaction through the shared Models wrapper without counting the summary twice", async () => {
    const faux = fauxProvider({ provider: "compaction-provider" });
    const summary = fauxAssistantMessage("bounded summary");
    summary.usage = { input: 12, output: 5, cacheRead: 1, cacheWrite: 0, totalTokens: 18, cost: piCost };
    faux.setResponses([summary]);
    const models = createModels();
    models.setProvider(faux.provider);
    const usage = new RecordingUsageRecorder();
    const tracked = trackPiModels(models, usage, () => ({ engine: "pi", purpose: "summary", workbenchId: "wb-compact" }));
    const messages: AgentMessage[] = [{ role: "user", content: "old context", timestamp: 1 }];

    const result = await generateSummary(messages, tracked, faux.getModel(), 512, undefined, undefined, undefined, undefined, undefined, BACKGROUND_CONTEXT);

    expect(result.ok).toBe(true);
    expect(usage.sessions).toHaveLength(1);
    expect(usage.sessions[0]?.context).toMatchObject({ engine: "pi", purpose: "summary", workbenchId: "wb-compact" });
    expect(usage.sessions[0]?.observations).toHaveLength(1);
  });

  it("keeps measured Pi spend on error and records unknown on an unresolved exception", async () => {
    const usage = new RecordingUsageRecorder();
    const measured = fauxAssistantMessage([], { errorMessage: "provider failed", stopReason: "error" });
    measured.usage = { input: 4, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 7, cost: piCost };
    const models = {
      completeSimple: vi.fn()
        .mockResolvedValueOnce(measured)
        .mockRejectedValueOnce(new Error("transport broke")),
    };
    const tracked = trackPiModels(models as never, usage, () => ({ engine: "pi", purpose: "probe" }));

    await expect(tracked.completeSimple({ id: "m", provider: "p" } as never, { messages: [] })).resolves.toBe(measured);
    await expect(tracked.completeSimple({ id: "m", provider: "p" } as never, { messages: [] })).rejects.toThrow("transport broke");

    expect(usage.sessions[0]?.observations[0]?.tokens).toEqual({ input: 6, output: 1, cacheRead: 2, cacheWrite: 0, reasoning: null });
    expect(usage.sessions[0]?.statuses).toEqual(["failed"]);
    expect(usage.sessions[1]?.observations).toEqual([{ key: "result", modelId: "m", sourceName: "p", tokens: null }]);
    expect(usage.sessions[1]?.statuses).toEqual(["failed"]);
  });
});
