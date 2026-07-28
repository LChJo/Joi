/* In-memory repository methods resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { ReasoningSourceSelector } from "../../src/main/application/model-sources/reasoning-source-selector.js";
import type { ModelSourceRecord, ModelSourceRepository } from "../../src/main/application/ports/model-source-ports.js";
import { createModelSource, type SourceFailureKind } from "../../src/main/domain/model-sources/model-source.js";

function source(sourceId: string, order: number): ModelSourceRecord {
  const model = createModelSource({
    createdAt: "2026-07-28T10:00:00.000Z", credentialRef: `joi-source:${sourceId}`, credentialVersion: 1,
    displayName: sourceId, kind: order === 0 ? "kimi" : "deepseek", modelCapability: "release-tested",
    modelId: `${sourceId}-model`, modelRevisionId: `${sourceId}-model-revision`, sourceId, sourceRevisionId: `${sourceId}-revision`,
  });
  return { local: false, order, primary: order === 0, source: { ...model, status: "READY" } };
}

const first = source("first", 0);
const second = source("second", 1);
const repository: ModelSourceRepository = {
  create: async () => undefined, delete: async () => undefined, get: async (id) => id === "first" ? first : id === "second" ? second : null,
  list: async () => [first, second], revise: async () => undefined, save: async () => undefined, setOrder: async () => undefined,
};

describe("deterministic-source-fallback-classification", () => {
  it.each(["timeout", "connect", "rate_limited", "server_error"] as SourceFailureKind[])("falls back for %s before output or side effects", async (failure) => {
    const selector = new ReasoningSourceSelector(repository);
    expect(await selector.selectInitial("turn-1")).toMatchObject({ modelId: "first-model", sourceId: "first", turnId: "turn-1" });
    expect(await selector.selectFallback({ currentSourceId: "first", failure, formalOutputStarted: false, sideEffectStarted: false, turnId: "turn-1" }))
      .toMatchObject({ modelId: "second-model", sourceId: "second" });
  });

  it.each(["auth", "balance", "configuration", "safety_refusal", "content_refusal"] as SourceFailureKind[])("does not switch for %s", async (failure) => {
    expect(await new ReasoningSourceSelector(repository).selectFallback({ currentSourceId: "first", failure, formalOutputStarted: false, sideEffectStarted: false, turnId: "turn-1" })).toBeNull();
  });

  it("does not replay a turn after output or side effects begin", async () => {
    const selector = new ReasoningSourceSelector(repository);
    expect(await selector.selectFallback({ currentSourceId: "first", failure: "timeout", formalOutputStarted: true, sideEffectStarted: false, turnId: "turn-1" })).toBeNull();
    expect(await selector.selectFallback({ currentSourceId: "first", failure: "timeout", formalOutputStarted: false, sideEffectStarted: true, turnId: "turn-1" })).toBeNull();
  });

  it("fails when no source is ready and returns no fallback for unknown or last sources", async () => {
    const empty = new ReasoningSourceSelector({ list: async () => [] });
    await expect(empty.selectInitial("turn-1")).rejects.toMatchObject({ code: "model_source_not_ready" });
    const selector = new ReasoningSourceSelector(repository);
    await expect(selector.selectFallback({ currentSourceId: "unknown", failure: "timeout", formalOutputStarted: false, sideEffectStarted: false, turnId: "turn-1" })).resolves.toBeNull();
    await expect(selector.selectFallback({ currentSourceId: "second", failure: "timeout", formalOutputStarted: false, sideEffectStarted: false, turnId: "turn-1" })).resolves.toBeNull();
  });
});
