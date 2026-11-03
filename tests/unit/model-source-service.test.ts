/* In-memory port doubles intentionally resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { ModelSourceService } from "../../src/main/application/model-sources/model-source-service.js";
import type {
  ModelSourceCatalog,
  ModelSourceEndpointPolicy,
  ModelSourceHealthRevision,
  ModelSourceRecord,
  ModelSourceRepository,
  ModelSourceSecretStore,
  ModelSourceValidator,
} from "../../src/main/application/ports/model-source-ports.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { ModelSourceNetworkPolicy } from "../../src/main/infrastructure/pi/model-source-network-policy.js";
import { PiModelSourceCatalog } from "../../src/main/infrastructure/pi/pi-model-source-catalog.js";

class MemoryModelSourceRepository implements ModelSourceRepository {
  readonly records = new Map<string, ModelSourceRecord>();
  async create(record: ModelSourceRecord) { this.records.set(record.source.sourceId, structuredClone(record)); }
  async get(sourceId: string) { return structuredClone(this.records.get(sourceId) ?? null); }
  async list() { return [...this.records.values()].sort((a, b) => a.order - b.order).map((item) => structuredClone(item)); }
  async save(record: ModelSourceRecord) { this.records.set(record.source.sourceId, structuredClone(record)); }
  async saveHealthIfCurrent(record: ModelSourceRecord, expected: ModelSourceHealthRevision) {
    const current = this.records.get(record.source.sourceId);
    const source = current?.source;
    if (source === undefined) return false;
    if (source.updatedAt !== expected.sourceUpdatedAt
      || source.activeSourceRevision.sourceRevisionId !== expected.sourceRevisionId
      || source.activeModelRevision.modelRevisionId !== expected.modelRevisionId
      || source.activeSourceRevision.credentialVersion !== expected.credentialVersion) return false;
    this.records.set(record.source.sourceId, structuredClone(record));
    return true;
  }
  async revise(record: ModelSourceRecord) { this.records.set(record.source.sourceId, structuredClone(record)); }
  async setOrder(sourceIds: string[]) {
    sourceIds.forEach((sourceId, order) => {
      const record = this.records.get(sourceId);
      if (record !== undefined) this.records.set(sourceId, { ...record, order, primary: order === 0 });
    });
  }
  async delete(sourceId: string) { this.records.delete(sourceId); }
}

describe("ModelSourceService", () => {
  it.each(["anthropic", "openai"] as const)("saves and validates an explicit LAN %s source while requiring a credential", async (protocol) => {
    const repository = new MemoryModelSourceRepository();
    const saveApiKey = vi.fn(async () => 1);
    const validate = vi.fn(async () => ({ status: "READY" as const, validatedAt: "2026-10-27T10:00:00.000Z" }));
    const service = new ModelSourceService({
      catalog: new PiModelSourceCatalog(),
      clock: new TestClock(),
      endpointPolicy: new ModelSourceNetworkPolicy({ resolve: async () => [] }),
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey },
      validator: { validate },
    });
    const input = { accessMode: "custom" as const, apiKey: "", baseUrl: "http://10.30.208.181:34567", displayName: "LAN model", kind: "generic-openai" as const, modelId: "deepseek-flash", protocol };
    await expect(service.create(input)).rejects.toMatchObject({ code: "model_source_key_required" });
    expect(saveApiKey).not.toHaveBeenCalled();
    const source = await service.create({ ...input, apiKey: "synthetic-lan-key" });
    await expect(service.validate(source.sourceId)).resolves.toMatchObject({ status: "READY", protocol });
    expect(validate).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "http://10.30.208.181:34567/", local: false }));
    expect(JSON.stringify(await service.list())).not.toContain("synthetic-lan-key");
    await expect(service.update(source.sourceId, { apiKey: "" })).rejects.toMatchObject({ code: "model_source_key_required" });
  });

  it("creates multiple sources, keeps keys behind the secret port, validates, and reorders deterministically", async () => {
    const repository = new MemoryModelSourceRepository();
    const savedSecrets: { apiKey: string | undefined; providerId: string }[] = [];
    const secrets: ModelSourceSecretStore = {
      delete: async () => undefined,
      saveApiKey: async (providerId, apiKey) => {
        savedSecrets.push({ apiKey, providerId });
        return savedSecrets.filter((item) => item.providerId === providerId).length;
      },
    };
    const catalog: ModelSourceCatalog = {
      resolve: (kind, requestedModelId, requestedAccessMode, requestedProtocol) => ({
        accessMode: requestedAccessMode ?? (kind === "generic-openai" ? "custom" : "api"),
        capability: requestedModelId === undefined ? "release-tested" : "custom-unverified-tools",
        displayName: kind === "kimi" ? "Kimi" : "通用平台",
        modelId: requestedModelId ?? "kimi-k2.5",
        protocol: requestedProtocol ?? "openai",
        ...(kind === "generic-openai" ? {} : { presetVersion: "2026-07-28" }),
      }),
    };
    const endpointPolicy: ModelSourceEndpointPolicy = {
      validate: async (url) => ({ local: url.includes("127.0.0.1"), url }),
    };
    const validator: ModelSourceValidator = {
      validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }),
    };
    const service = new ModelSourceService({
      catalog,
      clock: new TestClock(),
      endpointPolicy,
      ids: new TestIds(),
      repository,
      secrets,
      validator,
    });

    const kimi = await service.create({ accessMode: "coding-plan", apiKey: "model-source-test-secret", kind: "kimi", protocol: "anthropic" });
    const local = await service.create({
      apiKey: "",
      baseUrl: "http://127.0.0.1:11434/v1",
      displayName: "本机模型",
      kind: "generic-openai",
      modelId: "local-tool-model",
      protocol: "openai",
    });
    expect(kimi).toMatchObject({ accessMode: "coding-plan", kind: "kimi", order: 0, primary: true, protocol: "anthropic", status: "DRAFT" });
    expect(local).toMatchObject({ kind: "generic-openai", order: 1, primary: false, protocol: "openai", status: "DRAFT" });
    expect(savedSecrets).toEqual([
      { apiKey: "model-source-test-secret", providerId: `joi-source:${kimi.sourceId}` },
      { apiKey: undefined, providerId: `joi-source:${local.sourceId}` },
    ]);
    expect(JSON.stringify(await service.list())).not.toContain("model-source-test-secret");

    expect(await service.validate(kimi.sourceId)).toMatchObject({ lastValidatedAt: "2026-07-28T10:00:30.000Z", status: "READY" });
    await service.setOrder([local.sourceId, kimi.sourceId]);
    expect(await service.list()).toEqual([
      expect.objectContaining({ sourceId: local.sourceId, order: 0, primary: true }),
      expect.objectContaining({ sourceId: kimi.sourceId, order: 1, primary: false }),
    ]);
  });

  it("carries configured limits across an unrelated edit and resets them when the model changes", async () => {
    const repository = new MemoryModelSourceRepository();
    const catalog: ModelSourceCatalog = {
      resolve: (kind, requestedModelId, requestedAccessMode, requestedProtocol) => ({
        accessMode: requestedAccessMode ?? (kind === "generic-openai" ? "custom" : "api"),
        capability: "release-tested",
        displayName: "GLM",
        modelId: requestedModelId ?? "glm-5.2",
        protocol: requestedProtocol ?? "openai",
      }),
    };
    const service = new ModelSourceService({
      catalog,
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });

    const created = await service.create({
      apiKey: "model-source-test-secret",
      compactionThresholdPercent: 70,
      contextWindow: 400_000,
      kind: "glm",
      maxOutputTokens: 65_536,
      modelId: "glm-5.2",
    });
    expect(created.activeModel).toMatchObject({
      compactionThresholdPercent: 70, contextWindow: 400_000, maxOutputTokens: 65_536,
    });

    // An unrelated edit must carry the limits into the new revision. The revision table is
    // append-only and nothing merges the previous row back in, so a service that forgot them
    // would silently reset every limit the user configured on any edit at all.
    const rotated = await service.update(created.sourceId, { apiKey: "rotated" });
    expect(rotated.activeModel).toMatchObject({
      compactionThresholdPercent: 70, contextWindow: 400_000, maxOutputTokens: 65_536,
    });

    // null is the explicit "back to the provider default", and it clears only that one field.
    const cleared = await service.update(created.sourceId, { contextWindow: null });
    expect(cleared.activeModel.contextWindow).toBeUndefined();
    expect(cleared.activeModel.maxOutputTokens).toBe(65_536);

    // Switching Model ID drops the geometry: it described the model that was just replaced.
    const switched = await service.update(created.sourceId, { modelId: "glm-4.7" });
    expect(switched.activeModel.id).toBe("glm-4.7");
    expect(switched.activeModel.maxOutputTokens).toBeUndefined();
    expect(switched.activeModel.compactionThresholdPercent).toBeUndefined();
  });

  it("carries a configured thinking effort across an unrelated edit, clears it on null, and resets it when the model changes", async () => {
    const repository = new MemoryModelSourceRepository();
    const service = new ModelSourceService({
      catalog: {
        resolve: (kind, requestedModelId, requestedAccessMode, requestedProtocol) => ({
          accessMode: requestedAccessMode ?? (kind === "generic-openai" ? "custom" : "api"),
          capability: "release-tested",
          displayName: "GLM",
          modelId: requestedModelId ?? "glm-5.3-flash",
          protocol: requestedProtocol ?? "anthropic",
        }),
      },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });

    const created = await service.create({ apiKey: "model-source-test-secret", kind: "glm", thinkingEffort: "low" });
    expect(created.activeModel.thinkingEffort).toBe("low");

    // An unrelated edit must carry the tier into the new revision, like the limits.
    const rotated = await service.update(created.sourceId, { apiKey: "rotated" });
    expect(rotated.activeModel.thinkingEffort).toBe("low");

    // A different tier overwrites; null returns to joi's own allowlist judgement.
    const raised = await service.update(created.sourceId, { thinkingEffort: "max" });
    expect(raised.activeModel.thinkingEffort).toBe("max");
    const cleared = await service.update(created.sourceId, { thinkingEffort: null });
    expect(cleared.activeModel.thinkingEffort).toBeUndefined();

    // Switching Model ID drops the tier with the geometry: it described the replaced model.
    await service.update(created.sourceId, { thinkingEffort: "high" });
    const switched = await service.update(created.sourceId, { modelId: "glm-4.7" });
    expect(switched.activeModel.id).toBe("glm-4.7");
    expect(switched.activeModel.thinkingEffort).toBeUndefined();

    await expect(service.create({ apiKey: "model-source-test-secret", kind: "glm", thinkingEffort: "minimal" as never }))
      .rejects.toMatchObject({ code: "model_source_thinking_effort_invalid" });
  });

  it("rejects out-of-range limits at the domain boundary", async () => {
    const repository = new MemoryModelSourceRepository();
    const service = new ModelSourceService({
      catalog: {
        resolve: (kind, requestedModelId, requestedAccessMode, requestedProtocol) => ({
          accessMode: requestedAccessMode ?? "api",
          capability: "release-tested",
          displayName: "GLM",
          modelId: requestedModelId ?? "glm-5.2",
          protocol: requestedProtocol ?? "openai",
        }),
      },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });
    const base = { apiKey: "model-source-test-secret", kind: "glm" as const };
    await expect(service.create({ ...base, contextWindow: 100 }))
      .rejects.toMatchObject({ code: "model_source_context_window_invalid" });
    await expect(service.create({ ...base, maxOutputTokens: 10 }))
      .rejects.toMatchObject({ code: "model_source_max_output_invalid" });
    // 100 would mean compacting only once the request already fills the window.
    await expect(service.create({ ...base, compactionThresholdPercent: 100 }))
      .rejects.toMatchObject({ code: "model_source_compaction_threshold_invalid" });
  });

  it("keeps composer-gating failures visible without deleting drafts or source metadata", async () => {
    const repository = new MemoryModelSourceRepository();
    const service = new ModelSourceService({
      catalog: { resolve: () => ({ accessMode: "api", capability: "release-tested", displayName: "DeepSeek", modelId: "deepseek-chat", presetVersion: "2026-07-28", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ error: "401 invalid_api_key", reasonCode: "auth_failed", status: "NEEDS_AUTH", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });
    const source = await service.create({ apiKey: "bad-key", kind: "deepseek" });
    expect(await service.validate(source.sourceId)).toMatchObject({ lastError: "401 invalid_api_key", reasonCode: "auth_failed", status: "NEEDS_AUTH" });
    expect(await service.hasReadySource()).toBe(false);
    expect(await service.list()).toHaveLength(1);
  });

  it("updates through immutable revisions, supports disable, and removes credentials on delete", async () => {
    const repository = new MemoryModelSourceRepository();
    const deleted: string[] = [];
    let credentialVersion = 0;
    const service = new ModelSourceService({
      catalog: { resolve: (_kind, modelId) => ({ accessMode: "api", capability: modelId === "custom-model" ? "custom-unverified-tools" : "release-tested", displayName: "DeepSeek", modelId: modelId ?? "deepseek-chat", presetVersion: "2026-07-28", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: {
        delete: async (providerId) => { deleted.push(providerId); },
        saveApiKey: async () => { credentialVersion += 1; return credentialVersion; },
      },
      validator: { validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });
    const created = await service.create({ apiKey: "old-key", kind: "deepseek" });
    const originalSourceRevision = created.activeSourceRevisionId;
    const originalModelRevision = created.activeModel.revisionId;
    const updated = await service.update(created.sourceId, { apiKey: "new-key", modelId: "custom-model" });
    expect(updated.activeSourceRevisionId).not.toBe(originalSourceRevision);
    expect(updated.activeModel.revisionId).not.toBe(originalModelRevision);
    expect(updated.activeModel).toMatchObject({ capability: "custom-unverified-tools", id: "custom-model" });
    expect(updated.credential.version).toBe(2);
    expect(await service.disable(created.sourceId)).toMatchObject({ status: "DISABLED" });
    await service.delete(created.sourceId);
    expect(await service.list()).toEqual([]);
    expect(deleted).toEqual([`joi-source:${created.sourceId}`]);
  });

  it("rejects incomplete or unsafe source mutations and invalid order sets", async () => {
    const repository = new MemoryModelSourceRepository();
    const service = new ModelSourceService({
      catalog: { resolve: (kind, modelId) => ({ accessMode: kind === "generic-openai" ? "custom" : "api", capability: kind === "generic-openai" ? "custom-unverified-tools" : "release-tested", displayName: kind, modelId: modelId ?? "default", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: url.includes("127.0.0.1"), url }) },
      ids: new TestIds(), repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });
    await expect(service.create({ apiKey: "", kind: "generic-openai" })).rejects.toMatchObject({ code: "model_source_fields_required" });
    await expect(service.create({ apiKey: "", baseUrl: "https://public.example/v1", displayName: "Public", kind: "generic-openai", modelId: "model" })).rejects.toMatchObject({ code: "model_source_key_required" });
    await expect(service.create({ apiKey: "key", baseUrl: "https://public.example/v1", displayName: " ", kind: "generic-openai", modelId: "model" })).rejects.toMatchObject({ code: "model_source_name_invalid" });
    const direct = await service.create({ apiKey: "key", kind: "kimi" });
    await expect(service.setOrder([])).rejects.toMatchObject({ code: "model_source_order_invalid" });
    await expect(service.setOrder([direct.sourceId, direct.sourceId])).rejects.toMatchObject({ code: "model_source_order_invalid" });
    await expect(service.validate("missing")).rejects.toMatchObject({ code: "model_source_not_found" });
    await expect(service.update(direct.sourceId, { apiKey: "" })).rejects.toMatchObject({ code: "model_source_key_required" });
  });

  it("revises a keyless local generic source and normalizes remaining primary order after deletion", async () => {
    const repository = new MemoryModelSourceRepository();
    const service = new ModelSourceService({
      catalog: { resolve: (kind, modelId) => ({ accessMode: kind === "generic-openai" ? "custom" : "api", capability: kind === "generic-openai" ? "custom-unverified-tools" : "release-tested", displayName: kind, modelId: modelId ?? "default", protocol: "openai" }) },
      clock: new TestClock(), endpointPolicy: { validate: async (url) => ({ local: url.includes("127.0.0.1"), url }) }, ids: new TestIds(), repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });
    const first = await service.create({ apiKey: "key", kind: "kimi" });
    const local = await service.create({ apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", displayName: "Local", kind: "generic-openai", modelId: "old" });
    expect(await service.update(local.sourceId, { apiKey: "", baseUrl: "http://127.0.0.1:11435/v1", displayName: "Local 2", modelId: "new" }))
      .toMatchObject({ activeModel: { id: "new" }, baseUrl: "http://127.0.0.1:11435/v1", displayName: "Local 2", status: "DRAFT" });
    await service.delete(first.sourceId);
    expect(await service.list()).toEqual([expect.objectContaining({ order: 0, primary: true, sourceId: local.sourceId })]);
  });

  it("stores the raw validation error truncated and clears it on a later ready validation", async () => {
    const repository = new MemoryModelSourceRepository();
    let next: { error?: string; reasonCode?: string; status: "DEGRADED" | "NEEDS_AUTH" | "READY"; validatedAt: string } = {
      error: `500 ${"x".repeat(1200)}`, reasonCode: "server_error", status: "DEGRADED", validatedAt: "2026-07-28T10:00:30.000Z",
    };
    const service = new ModelSourceService({
      catalog: { resolve: () => ({ accessMode: "api", capability: "release-tested", displayName: "Qwen", modelId: "qwen3.7-plus", presetVersion: "2026-07-28", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => next },
    });
    const source = await service.create({ apiKey: "key", kind: "qwen" });
    const degraded = await service.validate(source.sourceId);
    expect(degraded).toMatchObject({ lastError: `500 ${"x".repeat(996)}…`, reasonCode: "server_error", status: "DEGRADED" });
    next = { status: "READY", validatedAt: "2026-07-28T10:00:31.000Z" };
    const ready = await service.validate(source.sourceId);
    expect(ready).toMatchObject({ status: "READY" });
    expect(ready.lastError).toBeUndefined();
    expect(ready.reasonCode).toBeUndefined();
  });

  it("does not publish a validation result after the source is revised during the probe", async () => {
    const repository = new MemoryModelSourceRepository();
    let release!: () => void;
    let probeStarted!: () => void;
    const service = new ModelSourceService({
      catalog: { resolve: () => ({ accessMode: "api", capability: "release-tested", displayName: "Qwen", modelId: "qwen3.7-plus", presetVersion: "2026-07-28", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => {
        probeStarted();
        await new Promise<void>((resolve) => { release = resolve; });
        return { status: "READY" as const, validatedAt: "2026-09-03T10:01:00.000Z" };
      } },
    });
    const source = await service.create({ apiKey: "key", kind: "qwen" });
    const validating = service.validate(source.sourceId);
    await new Promise<void>((resolve) => { probeStarted = resolve; });
    const current = await repository.get(source.sourceId);
    if (current === null) throw new Error("fixture_missing");
    await repository.revise({
      ...current,
      source: {
        ...current.source,
        activeSourceRevision: { ...current.source.activeSourceRevision, sourceRevisionId: "source-revision-new", credentialVersion: 2 },
        activeModelRevision: { ...current.source.activeModelRevision, modelRevisionId: "model-revision-new", modelId: "qwen3.7-max" },
        status: "DRAFT",
        updatedAt: "2026-09-03T10:00:30.000Z",
      },
    });
    release();

    await expect(validating).resolves.toMatchObject({ status: "DRAFT", activeSourceRevisionId: "source-revision-new" });
  });

  it("returns the current source when disable loses a conditional-write race", async () => {
    const repository = new MemoryModelSourceRepository();
    const service = new ModelSourceService({
      catalog: { resolve: () => ({ accessMode: "api", capability: "release-tested", displayName: "Qwen", modelId: "qwen3.7-plus", presetVersion: "2026-07-28", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });
    const created = await service.create({ apiKey: "key", kind: "qwen" });
    repository.saveHealthIfCurrent = async () => false;

    await expect(service.disable(created.sourceId)).resolves.toMatchObject({ sourceId: created.sourceId, status: "DRAFT" });
  });

  it("does not validate when the initial VALIDATING write loses its revision race", async () => {
    const repository = new MemoryModelSourceRepository();
    const validate = vi.fn();
    const service = new ModelSourceService({
      catalog: { resolve: () => ({ accessMode: "api", capability: "release-tested", displayName: "Qwen", modelId: "qwen3.7-plus", presetVersion: "2026-07-28", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate },
    });
    const created = await service.create({ apiKey: "key", kind: "qwen" });
    repository.saveHealthIfCurrent = async () => false;

    await expect(service.validate(created.sourceId)).resolves.toMatchObject({ sourceId: created.sourceId, status: "DRAFT" });
    expect(validate).not.toHaveBeenCalled();
  });

  it("keeps legacy repositories from overwriting a changed source during disable", async () => {
    const base = new MemoryModelSourceRepository();
    let reads = 0;
    const legacy: ModelSourceRepository = {
      create: base.create.bind(base),
      delete: base.delete.bind(base),
      get: async (sourceId) => {
        reads += 1;
        if (reads === 2) return null;
        return base.get(sourceId);
      },
      list: base.list.bind(base),
      revise: base.revise.bind(base),
      save: base.save.bind(base),
      setOrder: base.setOrder.bind(base),
    };
    const service = new ModelSourceService({
      catalog: { resolve: () => ({ accessMode: "api", capability: "release-tested", displayName: "Qwen", modelId: "qwen3.7-plus", presetVersion: "2026-07-28", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository: legacy,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });
    const created = await service.create({ apiKey: "key", kind: "qwen" });

    await expect(service.disable(created.sourceId)).resolves.toMatchObject({ sourceId: created.sourceId, status: "DRAFT" });
  });

  it("writes health through the legacy repository path for local generic sources", async () => {
    const base = new MemoryModelSourceRepository();
    const legacy: ModelSourceRepository = {
      create: base.create.bind(base),
      delete: base.delete.bind(base),
      get: base.get.bind(base),
      list: base.list.bind(base),
      revise: base.revise.bind(base),
      save: base.save.bind(base),
      setOrder: base.setOrder.bind(base),
    };
    const service = new ModelSourceService({
      catalog: { resolve: () => ({ accessMode: "custom", capability: "custom-unverified-tools", displayName: "Local", modelId: "local-model", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: true, url }) },
      ids: new TestIds(),
      repository: legacy,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ status: "READY", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });
    const created = await service.create({ apiKey: "", baseUrl: "http://127.0.0.1:11434/v1", displayName: "Local", kind: "generic-openai", modelId: "local-model" });

    await expect(service.disable(created.sourceId)).resolves.toMatchObject({ sourceId: created.sourceId, status: "DISABLED" });
  });
});
