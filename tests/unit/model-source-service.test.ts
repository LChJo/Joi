/* In-memory port doubles intentionally resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { ModelSourceService } from "../../src/main/application/model-sources/model-source-service.js";
import type {
  ModelSourceCatalog,
  ModelSourceEndpointPolicy,
  ModelSourceRecord,
  ModelSourceRepository,
  ModelSourceSecretStore,
  ModelSourceValidator,
} from "../../src/main/application/ports/model-source-ports.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

class MemoryModelSourceRepository implements ModelSourceRepository {
  readonly records = new Map<string, ModelSourceRecord>();
  async create(record: ModelSourceRecord) { this.records.set(record.source.sourceId, structuredClone(record)); }
  async get(sourceId: string) { return structuredClone(this.records.get(sourceId) ?? null); }
  async list() { return [...this.records.values()].sort((a, b) => a.order - b.order).map((item) => structuredClone(item)); }
  async save(record: ModelSourceRecord) { this.records.set(record.source.sourceId, structuredClone(record)); }
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

  it("keeps composer-gating failures visible without deleting drafts or source metadata", async () => {
    const repository = new MemoryModelSourceRepository();
    const service = new ModelSourceService({
      catalog: { resolve: () => ({ accessMode: "api", capability: "release-tested", displayName: "DeepSeek", modelId: "deepseek-chat", presetVersion: "2026-07-28", protocol: "openai" }) },
      clock: new TestClock(),
      endpointPolicy: { validate: async (url) => ({ local: false, url }) },
      ids: new TestIds(),
      repository,
      secrets: { delete: async () => undefined, saveApiKey: async () => 1 },
      validator: { validate: async () => ({ reasonCode: "auth_failed", status: "NEEDS_AUTH", validatedAt: "2026-07-28T10:00:30.000Z" }) },
    });
    const source = await service.create({ apiKey: "bad-key", kind: "deepseek" });
    expect(await service.validate(source.sourceId)).toMatchObject({ reasonCode: "auth_failed", status: "NEEDS_AUTH" });
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
});
