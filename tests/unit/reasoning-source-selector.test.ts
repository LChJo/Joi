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
  it("reuses a fresh READY source without probing", async () => {
    const fresh = { ...first, lastValidatedAt: "2026-09-03T10:00:00.000Z" };
    const validate = vi.fn();
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [fresh] }, {
      clock: { now: () => new Date("2026-09-03T10:04:59.000Z") },
      validator: { validate },
    });
    await expect(selector.selectInitial("turn-fresh")).resolves.toMatchObject({ sourceId: "first" });
    expect(validate).not.toHaveBeenCalled();
  });

  it("keeps the tool capability proof across a freshness probe", async () => {
    const staleProven = { ...first, lastValidatedAt: "2026-09-03T09:00:00.000Z", source: { ...first.source, toolProofAt: "2026-08-06T10:00:00.000Z" } };
    const validate = vi.fn(async () => ({ status: "READY" as const, validatedAt: "2026-09-03T10:00:00.000Z" }));
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [staleProven] }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate },
    });
    await expect(selector.selectInitial("turn-proven")).resolves.toMatchObject({ sourceId: "first", toolCapabilityProven: true });
    expect(validate).toHaveBeenCalled();
  });

  it("coalesces stale probes by source/model/credential revision and falls through for an unpinned partner", async () => {
    const staleFirst = { ...first, lastValidatedAt: "2026-09-03T09:00:00.000Z" };
    const staleSecond = { ...second, lastValidatedAt: "2026-09-03T09:00:00.000Z" };
    const saved: ModelSourceRecord[] = [];
    let release: (() => void) | undefined;
    const validate = vi.fn(async (record: ModelSourceRecord) => {
      if (record.source.sourceId === "first") await new Promise<void>((resolve) => { release = resolve; });
      return record.source.sourceId === "first"
        ? { reasonCode: "model_access_forbidden", status: "NEEDS_AUTH" as const, validatedAt: "2026-09-03T10:00:00.000Z" }
        : { status: "READY" as const, validatedAt: "2026-09-03T10:00:00.000Z" };
    });
    const repo = { ...repository, list: async () => [staleFirst, staleSecond], save: async (record: ModelSourceRecord) => { saved.push(record); } };
    const selector = new ReasoningSourceSelector(repo, { clock: { now: () => new Date("2026-09-03T10:00:00.000Z") }, validator: { validate } });
    const one = selector.selectInitial("turn-one");
    const two = selector.selectInitial("turn-two");
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1));
    release?.();
    await expect(Promise.all([one, two])).resolves.toEqual([
      expect.objectContaining({ sourceId: "second" }), expect.objectContaining({ sourceId: "second" }),
    ]);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(saved.some((record) => record.reasonCode === "model_access_forbidden" && record.source.status === "NEEDS_AUTH")).toBe(true);
  });

  it("does not persist a stale probe result after the active source revision changes", async () => {
    const stale = { ...first, lastValidatedAt: "2026-09-03T09:00:00.000Z" };
    const revised = {
      ...stale,
      source: {
        ...stale.source,
        activeSourceRevision: { ...stale.source.activeSourceRevision, sourceRevisionId: "first-revision-2", credentialVersion: 2 },
        activeModelRevision: { ...stale.source.activeModelRevision, modelRevisionId: "first-model-revision-2", modelId: "first-model-2" },
        status: "DRAFT" as const,
      },
    };
    let current: ModelSourceRecord = stale;
    let release!: () => void;
    const saved: ModelSourceRecord[] = [];
    const validate = vi.fn(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "READY" as const, validatedAt: "2026-09-03T10:01:00.000Z" };
    });
    const selector = new ReasoningSourceSelector({
      list: async () => [current],
      get: async () => current,
      save: async (record) => { saved.push(record); },
      saveHealthIfCurrent: async () => false,
    }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate },
    });

    const selection = selector.selectInitial("turn-race");
    await vi.waitFor(() => expect(validate).toHaveBeenCalledOnce());
    current = revised;
    release();

    await expect(selection).rejects.toMatchObject({ code: "model_source_not_ready" });
    expect(saved).toHaveLength(0);
  });

  it("locates a fallback from the full ordered list and freshness-checks it", async () => {
    const current = { ...first, source: { ...first.source, status: "NEEDS_AUTH" as const } };
    const staleFallback = { ...second, lastValidatedAt: "2026-09-03T09:00:00.000Z" };
    const validate = vi.fn(async () => ({ status: "READY" as const, validatedAt: "2026-09-03T10:00:00.000Z" }));
    const selector = new ReasoningSourceSelector({
      list: async () => [current, staleFallback],
      get: async (id) => id === current.source.sourceId ? current : staleFallback,
      save: async () => undefined,
    }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate },
    });

    await expect(selector.selectFallback({
      currentSourceId: current.source.sourceId,
      failure: "timeout",
      formalOutputStarted: false,
      sideEffectStarted: false,
      turnId: "turn-fallback-fresh",
    })).resolves.toMatchObject({ sourceId: staleFallback.source.sourceId });
    expect(validate).toHaveBeenCalledWith(staleFallback);
  });

  it("stops on a stale forbidden pinned source", async () => {
    const stale = { ...first, lastValidatedAt: "2026-09-03T09:00:00.000Z" };
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [stale], save: async () => undefined }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: async () => ({ reasonCode: "auth_forbidden", status: "NEEDS_AUTH", validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });
    await expect(selector.selectById("first", "turn-pinned")).rejects.toMatchObject({ code: "partner_model_source_auth_forbidden" });
  });

  it("skips a route that rejected a run for lacking completion budget until the window lapses", async () => {
    let nowMs = Date.parse("2026-09-03T10:00:00.000Z");
    const freshFirst = { ...first, lastValidatedAt: "2026-09-03T10:00:00.000Z" };
    const freshSecond = { ...second, lastValidatedAt: "2026-09-03T10:00:00.000Z" };
    const validate = vi.fn(async () => ({ status: "READY" as const, validatedAt: new Date(nowMs).toISOString() }));
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [freshFirst, freshSecond] }, {
      clock: { now: () => new Date(nowMs) },
      validator: { validate },
    });

    await selector.reportRunFailure("first", { detail: "max_completion_tokens is larger than the route allowance" });
    await expect(selector.selectInitial("turn-avoid")).resolves.toMatchObject({ sourceId: "second" });
    expect(validate).not.toHaveBeenCalled();

    nowMs += 31 * 60_000;
    await expect(selector.selectInitial("turn-after-avoidance")).resolves.toMatchObject({ sourceId: "first" });
    expect(validate).toHaveBeenCalledOnce();
  });

  it("does not offer a capacity-avoided route as a fallback", async () => {
    const selector = new ReasoningSourceSelector(repository);
    await selector.reportRunFailure("second", { detail: "completion budget exhausted for this route" });
    await expect(selector.selectFallback({
      currentSourceId: "first", failure: "timeout", formalOutputStarted: false, sideEffectStarted: false, turnId: "turn-fallback-avoid",
    })).resolves.toBeNull();
  });

  it("deprioritizes a route that rejected the request for exceeding its window", async () => {
    const freshFirst = { ...first, lastValidatedAt: "2026-09-03T10:00:00.000Z" };
    const freshSecond = { ...second, lastValidatedAt: "2026-09-03T10:00:00.000Z" };
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [freshFirst, freshSecond] }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: vi.fn() },
    });
    await expect(selector.selectInitial("turn-before")).resolves.toMatchObject({ sourceId: "first" });

    // An input that exceeded the window outright is the same capacity mismatch as one that left no
    // completion budget; unhandled, the next large dispatch rediscovers it on the same route.
    await selector.reportRunFailure("first", { code: "context_too_large" });
    await expect(selector.selectInitial("turn-after")).resolves.toMatchObject({ sourceId: "second" });

    // Avoiding every route must never strand a dispatch: the second pass still reaches them.
    await selector.reportRunFailure("second", { code: "context_too_large" });
    await expect(selector.selectInitial("turn-all-avoided")).resolves.toMatchObject({ sourceId: "first" });
  });

  it("removes a runtime 403 source before running one diagnostic probe", async () => {
    const states: ModelSourceRecord[] = [];
    const validate = vi.fn(async () => ({ reasonCode: "model_access_forbidden", status: "NEEDS_AUTH" as const, validatedAt: "2026-09-03T10:00:01.000Z" }));
    const selector = new ReasoningSourceSelector({
      ...repository,
      get: async () => first,
      save: async (record: ModelSourceRecord) => { states.push(record); },
    }, { clock: { now: () => new Date("2026-09-03T10:00:00.000Z") }, validator: { validate } });

    await selector.reportRunFailure("first", { detail: "403 model is not available for this account", status: 403 });

    expect(states[0]).toMatchObject({ reasonCode: "model_access_forbidden", source: { status: "NEEDS_AUTH" } });
    expect(validate).toHaveBeenCalledOnce();
    expect(states.at(-1)).toMatchObject({ reasonCode: "model_access_forbidden", source: { status: "NEEDS_AUTH" } });
    expect(JSON.stringify(states)).not.toContain("not available for this account");
  });

  it("does not probe when the conditional auth mark loses a revision race", async () => {
    const validate = vi.fn();
    const selector = new ReasoningSourceSelector({
      ...repository,
      get: async () => first,
      saveHealthIfCurrent: async () => false,
    }, { clock: { now: () => new Date("2026-09-03T10:00:00.000Z") }, validator: { validate } });

    await selector.reportRunFailure("first", { status: 403 });

    expect(validate).not.toHaveBeenCalled();
  });

  it("does not run a diagnostic probe after the source disappears", async () => {
    let reads = 0;
    const validate = vi.fn();
    const selector = new ReasoningSourceSelector({
      ...repository,
      get: async () => (++reads === 1 ? first : null),
      saveHealthIfCurrent: async () => true,
    }, { clock: { now: () => new Date("2026-09-03T10:00:00.000Z") }, validator: { validate } });

    await selector.reportRunFailure("first", { status: 403 });

    expect(validate).not.toHaveBeenCalled();
  });

  it.each([
    [{ statusCode: 401 }, "auth_failed"],
    [{ code: "http_401" }, "auth_failed"],
    [{ code: "http_403" }, "http_403"],
  ] as const)("accepts alternate provider status shapes without persisting provider text", async (failure, reasonCode) => {
    const states: ModelSourceRecord[] = [];
    const validate = vi.fn(async () => ({ status: "READY" as const, validatedAt: "2026-09-03T10:00:01.000Z" }));
    const selector = new ReasoningSourceSelector({
      ...repository,
      get: async () => first,
      save: async (record: ModelSourceRecord) => { states.push(record); },
    }, { clock: { now: () => new Date("2026-09-03T10:00:00.000Z") }, validator: { validate } });

    await selector.reportRunFailure("first", failure);

    expect(states[0]).toMatchObject({ reasonCode, source: { status: "NEEDS_AUTH" } });
    expect(validate).toHaveBeenCalledOnce();
  });

  it("ignores non-auth failures and auth failures for records that no longer exist", async () => {
    const save = vi.fn();
    const validate = vi.fn();
    const selector = new ReasoningSourceSelector({ ...repository, get: async () => null, save }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") }, validator: { validate },
    });

    await selector.reportRunFailure("first", null);
    await selector.reportRunFailure("first", { code: "unrelated" });
    await selector.reportRunFailure("first", { status: 403 });
    await new ReasoningSourceSelector({ list: async () => [first] }).reportRunFailure("first", { status: 403 });
    await new ReasoningSourceSelector({ list: async () => [first] }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") }, validator: { validate },
    }).reportRunFailure("first", { status: 403 });

    expect(save).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
  });

  it("probes a never-validated source and bounds a non-403 diagnostic error", async () => {
    const neverValidated = { ...first, baseUrl: "https://example.invalid/v1", presetVersion: "2" };
    const saved: ModelSourceRecord[] = [];
    const selector = new ReasoningSourceSelector({
      ...repository,
      list: async () => [neverValidated],
      save: async (record: ModelSourceRecord) => { saved.push(record); },
    }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      freshnessMillis: 1,
      validator: { validate: async () => ({ error: "x".repeat(1_100), reasonCode: "endpoint_unreachable", status: "DEGRADED", validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });

    await expect(selector.selectInitial("turn-never-validated")).rejects.toMatchObject({ code: "model_source_not_ready" });
    expect(saved[0]).toMatchObject({ baseUrl: neverValidated.baseUrl, presetVersion: "2", reasonCode: "endpoint_unreachable" });
    expect(saved[0]?.lastError).toHaveLength(1_000);
  });

  it("returns the latest record when a legacy health write detects a revision change", async () => {
    const stale = { ...first, lastValidatedAt: "2026-09-03T09:00:00.000Z" };
    const current = { ...stale, source: { ...stale.source, status: "DRAFT" as const, updatedAt: "2026-09-03T09:30:00.000Z" } };
    const save = vi.fn();
    const selector = new ReasoningSourceSelector({
      list: async () => [stale],
      get: async () => current,
      save,
    }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: async () => ({ status: "READY" as const, validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });

    await expect(selector.selectInitial("turn-legacy-race")).rejects.toMatchObject({ code: "model_source_not_ready" });
    expect(save).not.toHaveBeenCalled();
  });

  it("supports a legacy repository without a get method for health writes", async () => {
    const stale = { ...first, lastValidatedAt: "2026-09-03T09:00:00.000Z" };
    const save = vi.fn();
    const selector = new ReasoningSourceSelector({
      list: async () => [stale],
      save,
    }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: async () => ({ status: "READY" as const, validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });

    await expect(selector.selectInitial("turn-legacy-save")).resolves.toMatchObject({ sourceId: "first" });
    expect(save).toHaveBeenCalledOnce();
  });

  it("skips non-ready and failed-ready fallback candidates", async () => {
    const blocked = { ...second, source: { ...second.source, sourceId: "blocked", status: "DRAFT" as const } };
    const candidate = { ...second, source: { ...second.source, sourceId: "candidate" }, lastValidatedAt: "2026-09-03T09:00:00.000Z" };
    const selector = new ReasoningSourceSelector({
      list: async () => [first, blocked, candidate],
      save: async () => undefined,
    }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: async () => ({ status: "NEEDS_AUTH" as const, validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });

    await expect(selector.selectFallback({
      currentSourceId: "first", failure: "timeout", formalOutputStarted: false, sideEffectStarted: false, turnId: "turn-skip-candidates",
    })).resolves.toBeNull();
  });

  it("does not expose an unsafe validator reason in a pinned-source error code", async () => {
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [first], save: async () => undefined }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: async () => ({ reasonCode: "unsafe reason!", status: "NEEDS_AUTH", validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });

    await expect(selector.selectById("first", "turn-unsafe-reason")).rejects.toMatchObject({ code: "partner_model_source_not_ready" });
  });

  it("uses a generic pinned-source error when a failed probe has no reason code", async () => {
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [first], save: async () => undefined }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: async () => ({ status: "NEEDS_AUTH", validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });

    await expect(selector.selectById("first", "turn-no-reason")).rejects.toMatchObject({ code: "partner_model_source_not_ready" });
  });

  it("names the pinned source and its state when a pin is no longer READY", async () => {
    // Editing a source drops it back to DRAFT while the partners pinned to it keep the old pin.
    const draft = { ...first, source: { ...first.source, status: "DRAFT" as const } };
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [draft] }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: async () => ({ status: "READY" as const, validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });

    await expect(selector.selectById("first", "turn-draft-pin")).rejects.toMatchObject({
      code: "partner_model_source_not_ready",
      message: 'The partner is pinned to "first", which is DRAFT rather than READY.',
    });
  });

  it("reports a pin whose source is gone without inventing a state for it", async () => {
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [first] }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: async () => ({ status: "READY" as const, validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });

    await expect(selector.selectById("deleted-source", "turn-missing-pin")).rejects.toMatchObject({
      code: "partner_model_source_not_ready",
      message: "The partner is pinned to a model source that no longer exists.",
    });
  });

  it("keeps list-only selector compatibility even when freshness options are supplied", async () => {
    const validate = vi.fn();
    const selector = new ReasoningSourceSelector({ list: async () => [first] }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") }, validator: { validate },
    });

    await expect(selector.selectInitial("turn-list-only")).resolves.toMatchObject({ sourceId: "first" });
    expect(validate).not.toHaveBeenCalled();
  });

  it("skips a probe when the source becomes fresh between the dispatch and coalescing checks", async () => {
    const now = vi.fn()
      .mockReturnValueOnce(new Date("2026-09-03T10:06:00.000Z"))
      .mockReturnValue(new Date("2026-09-03T10:04:00.000Z"));
    const validate = vi.fn();
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [{ ...first, lastValidatedAt: "2026-09-03T10:00:00.000Z" }] }, {
      clock: { now }, validator: { validate },
    });

    await expect(selector.selectInitial("turn-became-fresh")).resolves.toMatchObject({ sourceId: "first" });
    expect(validate).not.toHaveBeenCalled();
  });

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

  it("replays a protocol failure after text output but never after a side effect", async () => {
    const selector = new ReasoningSourceSelector(repository);
    // Leaked tool-call markup only ever produced garbage text, so redoing the Turn on
    // another route is safe even though formal output started.
    await expect(selector.selectFallback({ currentSourceId: "first", failure: "protocol", formalOutputStarted: true, sideEffectStarted: false, turnId: "turn-1" }))
      .resolves.toMatchObject({ modelId: "second-model", sourceId: "second" });
    expect(await selector.selectFallback({ currentSourceId: "first", failure: "protocol", formalOutputStarted: true, sideEffectStarted: true, turnId: "turn-1" })).toBeNull();
  });

  it("fails when no source is ready and returns no fallback for unknown or last sources", async () => {
    const empty = new ReasoningSourceSelector({ list: async () => [] });
    await expect(empty.selectInitial("turn-1")).rejects.toMatchObject({ code: "model_source_not_ready" });
    const selector = new ReasoningSourceSelector(repository);
    await expect(selector.selectFallback({ currentSourceId: "unknown", failure: "timeout", formalOutputStarted: false, sideEffectStarted: false, turnId: "turn-1" })).resolves.toBeNull();
    await expect(selector.selectFallback({ currentSourceId: "second", failure: "timeout", formalOutputStarted: false, sideEffectStarted: false, turnId: "turn-1" })).resolves.toBeNull();
  });

  it("pins the READY source selected by an immutable partner revision", async () => {
    const selector = new ReasoningSourceSelector(repository);
    await expect(selector.selectById("second", "partner-run-1")).resolves.toMatchObject({
      modelId: "second-model", sourceId: "second", turnId: "partner-run-1",
    });
    await expect(selector.selectById("missing", "partner-run-2"))
      .rejects.toMatchObject({ code: "partner_model_source_not_ready" });
  });
});
