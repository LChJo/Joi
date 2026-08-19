/* In-memory registry implements asynchronous persistence immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { createHash } from "node:crypto";

import { PartnerKnowledgeService } from "../../src/main/application/partners/partner-knowledge-service.js";
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import type { PartnerPromptStore } from "../../src/main/application/ports/partner-execution.js";
import type { PartnerKnowledgeDocMeta, PartnerKnowledgeStore } from "../../src/main/application/ports/partner-knowledge.js";
import type { AppendPartnerRevisionInput, PartnerRegistryRepository } from "../../src/main/application/ports/partner-registry.js";
import type { PartnerRevision } from "../../src/main/domain/partners/partner.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

class MemoryPartnerRegistry implements PartnerRegistryRepository {
  readonly history: PartnerRevision[] = [];
  readonly inFlight = new Map<string, number>();
  async append(input: AppendPartnerRevisionInput): Promise<PartnerRevision> {
    const revision = { ...structuredClone(input), registryRevision: this.history.length + 1 };
    this.history.push(revision);
    return revision;
  }
  async getActive(partnerId: string) { return this.history.findLast((item) => item.partnerId === partnerId) ?? null; }
  async getRevision(partnerRevisionId: string) { return this.history.find((item) => item.partnerRevisionId === partnerRevisionId) ?? null; }
  async listActive() { return [...new Map(this.history.map((item) => [item.partnerId, item])).values()]; }
  async countInFlight(partnerId: string) { return this.inFlight.get(partnerId) ?? 0; }
}

class MemoryPartnerPrompts implements PartnerPromptStore {
  readonly records = new Map<string, string>();
  async read(promptRef: string) { return this.records.get(promptRef) ?? null; }
  async save(input: { body: string; createdAt: string; promptRef: string }) { this.records.set(input.promptRef, input.body); }
}

class MemoryKnowledgeStore implements PartnerKnowledgeStore {
  readonly docs: { body: string; bytes: number; createdAt: string; docId: string; filename: string; partnerId: string; sha256: string }[] = [];
  async count(partnerId: string) { return this.docs.filter((doc) => doc.partnerId === partnerId).length; }
  async copyTo(srcPartnerId: string, dstPartnerId: string, nextDocId: () => string, createdAt: string) {
    const rows = this.docs.filter((doc) => doc.partnerId === srcPartnerId);
    for (const row of rows) this.docs.push({ ...row, createdAt, docId: nextDocId(), partnerId: dstPartnerId });
    return rows.length;
  }
  async listMeta(partnerId: string): Promise<PartnerKnowledgeDocMeta[]> {
    return this.docs.filter((doc) => doc.partnerId === partnerId)
      .map((doc) => ({ bytes: doc.bytes, createdAt: doc.createdAt, docId: doc.docId, filename: doc.filename, sha256: doc.sha256 }));
  }
  async readBodies(partnerId: string) {
    return this.docs.filter((doc) => doc.partnerId === partnerId).map((doc) => ({ body: doc.body, filename: doc.filename }));
  }
  async remove(partnerId: string, docId: string) {
    const index = this.docs.findIndex((doc) => doc.docId === docId && doc.partnerId === partnerId);
    if (index === -1) return false;
    this.docs.splice(index, 1);
    return true;
  }
  async save(input: { body: string; bytes: number; createdAt: string; docId: string; filename: string; partnerId: string }) {
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    this.docs.push({ ...input, sha256 });
    return sha256;
  }
}

describe("partner-registry-revision-before-dispatch", () => {
  it("increments immutable registry revisions before every new dispatch pin", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const first = await service.add({ capabilities: ["research"], displayName: "本机搭档", kind: "local-pi", skills: ["web"], tools: ["read"] });
    const firstPin = await service.pinForDispatch(first.partnerId);
    const second = await service.update(first.partnerId, { capabilities: ["research", "write"], displayName: "本机搭档", skills: ["web"], tools: ["read", "edit"] });
    const secondPin = await service.pinForDispatch(first.partnerId);
    expect(repository.history.map((item) => item.registryRevision)).toEqual([1, 2]);
    expect(firstPin).toEqual({ partnerId: first.partnerId, partnerRevisionId: first.partnerRevisionId, registryRevision: 1 });
    expect(secondPin).toEqual({ partnerId: first.partnerId, partnerRevisionId: second.partnerRevisionId, registryRevision: 2 });
    expect(second.partnerRevisionId).not.toBe(first.partnerRevisionId);
  });

  it("switches only the model pin by appending a new immutable partner revision", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const first = await service.add({
      capabilities: ["code"], description: "kept", displayName: "Coder", kind: "local-pi",
      modelSourceId: "source_old", skills: ["typescript"], tools: ["read", "edit"],
    });
    const switched = await service.setModel(first.partnerId, {
      modelIdOverride: "kimi-k2.5", modelSourceId: "source_ready",
    });

    expect(switched).toMatchObject({
      capabilities: ["code"], description: "kept", displayName: "Coder", modelIdOverride: "kimi-k2.5",
      modelSourceId: "source_ready", registryRevision: 2, skills: ["typescript"], tools: ["read", "edit"],
    });
    expect(switched.partnerRevisionId).not.toBe(first.partnerRevisionId);
    expect(repository.history).toHaveLength(2);
  });

  it("keeps local prompt and tools when refreshing an A2A Card and redacts prompt references publicly", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const first = await service.add({
      capabilities: ["old"], displayName: "远端", kind: "a2a", promptRef: "secret-prompt-ref",
      skills: ["old-skill"], tools: ["approved-local-tool"],
    });
    const refreshed = await service.refreshA2aCard(first.partnerId, { capabilities: ["new"], displayName: "Card Name", skills: ["card-skill"], tools: ["untrusted-tool"] });
    expect(repository.history[1]).toMatchObject({ promptRef: "secret-prompt-ref", tools: ["approved-local-tool"] });
    expect(refreshed).toMatchObject({ capabilities: ["new"], displayName: "Card Name", skills: ["card-skill"], tools: ["approved-local-tool"] });
    expect(JSON.stringify(refreshed)).not.toMatch(/secret-prompt-ref/u);
  });

  it("lists and disables partners while preventing disabled or missing dispatch pins", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const partner = await service.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [] });
    expect(await service.list()).toEqual([partner]);
    expect(await service.disable(partner.partnerId)).toMatchObject({ registryRevision: 2, status: "DISABLED" });
    await expect(service.pinForDispatch(partner.partnerId)).rejects.toMatchObject({ code: "partner_not_available" });
    await expect(service.pinForDispatch("missing")).rejects.toMatchObject({ code: "partner_not_found" });
  });

  it("drains disabled partners and refuses deletion until all pinned attempts are terminal", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const partner = await service.add({ capabilities: [], displayName: "Drain", kind: "local-pi", skills: [], tools: [] });
    repository.inFlight.set(partner.partnerId, 2);

    expect(await service.disable(partner.partnerId)).toMatchObject({ inFlightCount: 2, lifecyclePolicy: "DRAIN", status: "DISABLED" });
    await expect(service.pinForDispatch(partner.partnerId)).rejects.toMatchObject({ code: "partner_not_available" });
    await expect(service.delete(partner.partnerId)).rejects.toMatchObject({ code: "partner_delete_in_flight" });

    repository.inFlight.set(partner.partnerId, 0);
    expect(await service.delete(partner.partnerId)).toMatchObject({ inFlightCount: 0, status: "DELETED" });
    expect(await service.list()).toEqual([]);
    expect(repository.history.map((revision) => revision.status)).toEqual(["ACTIVE", "DISABLED", "DELETED"]);
  });

  it("requires disable before deletion and keeps repeated lifecycle commands idempotent", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const partner = await service.add({ capabilities: [], displayName: "Lifecycle", kind: "local-pi", skills: [], tools: [] });

    await expect(service.delete(partner.partnerId)).rejects.toMatchObject({ code: "partner_disable_before_delete" });
    const disabled = await service.disable(partner.partnerId);
    expect(await service.disable(partner.partnerId)).toEqual(disabled);
    const deleted = await service.delete(partner.partnerId);
    expect(await service.delete(partner.partnerId)).toEqual(deleted);
    await expect(service.disable(partner.partnerId)).rejects.toMatchObject({ code: "partner_not_found" });
  });

  it("rejects Card refresh for local partners and accepts explicit local override updates", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const partner = await service.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [] });
    await expect(service.refreshA2aCard(partner.partnerId, { capabilities: [], displayName: "Card", skills: [] })).rejects.toMatchObject({ code: "partner_card_kind_invalid" });
    expect(await service.update(partner.partnerId, { capabilities: ["new"], displayName: "Updated", promptRef: "prompt", skills: ["skill"], tools: ["tool"] }))
      .toMatchObject({ capabilities: ["new"], displayName: "Updated", skills: ["skill"], tools: ["tool"] });
  });

  it("persists local prompt bodies behind immutable private references", async () => {
    const prompts = new MemoryPartnerPrompts();
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), prompts, repository });

    const partner = await service.add({
      capabilities: ["code"], displayName: "Coder", kind: "local-pi", prompt: "  Work only inside the assigned repository.  ",
      skills: [], tools: ["read"],
    });

    const privateRef = repository.history[0]?.promptRef;
    expect(privateRef).toMatch(/^partner_prompt_/u);
    expect(prompts.records.get(privateRef ?? "")).toBe("Work only inside the assigned repository.");
    expect(JSON.stringify(partner)).not.toContain("Work only inside");
    expect(JSON.stringify(partner)).not.toContain(privateRef);
  });

  it("rejects empty, oversized or unstorable prompt bodies", async () => {
    const fields = { capabilities: [], displayName: "Local", kind: "local-pi" as const, skills: [], tools: [] };
    const withoutStore = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new MemoryPartnerRegistry() });
    await expect(withoutStore.add({ ...fields, prompt: "configured" })).rejects.toMatchObject({ code: "partner_prompt_store_unavailable" });
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), prompts: new MemoryPartnerPrompts(), repository: new MemoryPartnerRegistry() });
    await expect(service.add({ ...fields, prompt: "   " })).rejects.toMatchObject({ code: "partner_prompt_empty" });
    await expect(service.add({ ...fields, prompt: "x".repeat(32_001) })).rejects.toMatchObject({ code: "partner_prompt_too_large" });
  });

  it("enables disabled partners through the same immutable revision mechanism as disable", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const partner = await service.add({ capabilities: [], displayName: "Toggle", kind: "local-pi", skills: [], tools: [] });
    await service.disable(partner.partnerId);
    const enabled = await service.enable(partner.partnerId);
    expect(enabled).toMatchObject({ registryRevision: 3, status: "ACTIVE" });
    expect(await service.enable(partner.partnerId)).toEqual(enabled);
    expect(repository.history.map((revision) => revision.status)).toEqual(["ACTIVE", "DISABLED", "ACTIVE"]);
    await expect(service.enable("missing")).rejects.toMatchObject({ code: "partner_not_found" });
  });

  it("duplicates a partner into an independent copy with fresh prompt and knowledge rows", async () => {
    const store = new MemoryKnowledgeStore();
    const knowledge = new PartnerKnowledgeService({ clock: new TestClock(), ids: new TestIds(), store });
    const prompts = new MemoryPartnerPrompts();
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), knowledge, prompts, repository });

    const original = await service.add({
      capabilities: ["code"], description: "工程搭档", displayName: "Coder", kind: "local-pi",
      prompt: "只做小事", skills: ["typescript"], tools: ["read"],
    });
    await knowledge.add({ body: "# 规范\n先读后写。", filename: "guide.md", partnerId: original.partnerId });

    const copy = await service.duplicate(original.partnerId);
    expect(copy.partnerId).not.toBe(original.partnerId);
    expect(copy.displayName).toBe("Coder（副本）");
    expect(copy).toMatchObject({ capabilities: ["code"], createdBy: "user", description: "工程搭档", engine: "pi-core", knowledgeDocCount: 1, status: "ACTIVE" });
    expect(copy.registryRevision).not.toBe(original.registryRevision);

    const originalRevision = repository.history.find((revision) => revision.partnerId === original.partnerId);
    const copyRevision = repository.history.find((revision) => revision.partnerId === copy.partnerId);
    expect(copyRevision?.promptRef).not.toBe(originalRevision?.promptRef);
    expect(prompts.records.get(copyRevision?.promptRef ?? "")).toBe("只做小事");
    expect(prompts.records.size).toBe(2);
    expect(store.docs.map((doc) => doc.docId)).toHaveLength(2);
    expect(new Set(store.docs.map((doc) => doc.docId)).size).toBe(2);
    expect(JSON.stringify(copy)).not.toContain("只做小事");
  });

  it("validates engine and description constraints on partner revisions", async () => {
    const fields = { capabilities: [], displayName: "Local", skills: [], tools: [] };
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new MemoryPartnerRegistry() });
    await expect(service.add({ ...fields, engine: "claude-code", kind: "a2a" })).rejects.toMatchObject({ code: "partner_engine_kind_invalid" });
    await expect(service.add({ ...fields, description: "x".repeat(601), kind: "local-pi" })).rejects.toMatchObject({ code: "partner_description_invalid" });
    await expect(service.add({ ...fields, engine: "claude-code", engineModelId: "x".repeat(241), kind: "local-pi" })).rejects.toMatchObject({ code: "partner_engine_model_invalid" });
    await expect(service.add({ ...fields, kind: "local-pi", modelIdOverride: "x".repeat(241) })).rejects.toMatchObject({ code: "partner_model_override_invalid" });
    await expect(service.add({ ...fields, kind: "local-pi", modelSourceId: "x".repeat(241) })).rejects.toMatchObject({ code: "partner_model_source_invalid" });
    await expect(service.add({
      ...fields,
      kind: "local-pi",
      tools: Array.from({ length: 65 }, (_, index) => `tool-${String(index)}`),
    })).rejects.toMatchObject({ code: "partner_tools_invalid" });
    const cli = await service.add({ ...fields, engine: "claude-code", engineModelId: "claude-sonnet", kind: "local-pi" });
    expect(cli).toMatchObject({ engine: "claude-code", engineModelId: "claude-sonnet" });
    const codex = await service.add({ ...fields, engine: "codex", kind: "local-pi" });
    expect(codex).toMatchObject({ engine: "codex" });
  });

  it("validates local skills against the selected engine and updates only the skill set", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({
      clock: new TestClock(),
      ids: new TestIds(),
      repository,
      skills: { listForEngine: () => [{ displayName: "Demo", id: "claude-code/demo-skill" }] },
    });
    const partner = await service.add({ capabilities: ["code"], description: "Coder", displayName: "Coder", kind: "local-pi", skills: [], tools: ["read"] });
    await expect(service.update(partner.partnerId, { capabilities: ["code"], description: "Coder", displayName: "Coder", skills: ["missing-skill"], tools: ["read"] }))
      .rejects.toMatchObject({ code: "partner_skill_not_available" });
    const updated = await service.setSkills(partner.partnerId, ["claude-code/demo-skill"]);
    expect(updated).toMatchObject({ capabilities: ["code"], description: "Coder", displayName: "Coder", skills: ["claude-code/demo-skill"], tools: ["read"] });
    expect(updated.partnerRevisionId).not.toBe(partner.partnerRevisionId);
    expect(repository.history).toHaveLength(2);
  });
});
