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

  it("stops on a stale forbidden pinned source", async () => {
    const stale = { ...first, lastValidatedAt: "2026-09-03T09:00:00.000Z" };
    const selector = new ReasoningSourceSelector({ ...repository, list: async () => [stale], save: async () => undefined }, {
      clock: { now: () => new Date("2026-09-03T10:00:00.000Z") },
      validator: { validate: async () => ({ reasonCode: "auth_forbidden", status: "NEEDS_AUTH", validatedAt: "2026-09-03T10:00:00.000Z" }) },
    });
    await expect(selector.selectById("first", "turn-pinned")).rejects.toMatchObject({ code: "partner_model_source_auth_forbidden" });
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
