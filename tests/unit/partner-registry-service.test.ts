/* In-memory registry implements asynchronous persistence immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import type { PartnerPromptStore } from "../../src/main/application/ports/partner-execution.js";
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

describe("partner-registry-revision-before-dispatch", () => {
  it("increments immutable registry revisions before every new dispatch pin", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const first = await service.add({ capabilities: ["research"], displayName: "本机搭档", kind: "local-pi", skills: ["web"], tools: ["read"], workspaceRef: "workspace-alias" });
    const firstPin = await service.pinForDispatch(first.partnerId);
    const second = await service.update(first.partnerId, { capabilities: ["research", "write"], displayName: "本机搭档", skills: ["web"], tools: ["read", "edit"] });
    const secondPin = await service.pinForDispatch(first.partnerId);
    expect(repository.history.map((item) => item.registryRevision)).toEqual([1, 2]);
    expect(firstPin).toEqual({ partnerId: first.partnerId, partnerRevisionId: first.partnerRevisionId, registryRevision: 1 });
    expect(secondPin).toEqual({ partnerId: first.partnerId, partnerRevisionId: second.partnerRevisionId, registryRevision: 2 });
    expect(second.partnerRevisionId).not.toBe(first.partnerRevisionId);
  });

  it("keeps local workspace, prompt and tools when refreshing an A2A Card and redacts them publicly", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const first = await service.add({
      capabilities: ["old"], displayName: "远端", kind: "a2a", promptRef: "secret-prompt-ref",
      skills: ["old-skill"], tools: ["approved-local-tool"], workspaceRef: "private-workspace-ref",
    });
    const refreshed = await service.refreshA2aCard(first.partnerId, { capabilities: ["new"], displayName: "Card Name", skills: ["card-skill"], tools: ["untrusted-tool"], workspaceRef: "untrusted-workspace" });
    expect(repository.history[1]).toMatchObject({ promptRef: "secret-prompt-ref", tools: ["approved-local-tool"], workspaceRef: "private-workspace-ref" });
    expect(refreshed).toMatchObject({ capabilities: ["new"], displayName: "Card Name", skills: ["card-skill"], tools: ["approved-local-tool"] });
    expect(JSON.stringify(refreshed)).not.toMatch(/secret-prompt-ref|private-workspace-ref/u);
  });

  it("lists and disables partners while preventing disabled or missing dispatch pins", async () => {
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository });
    const partner = await service.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [], workspaceRef: "workspace" });
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
    const partner = await service.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [], workspaceRef: "old" });
    await expect(service.refreshA2aCard(partner.partnerId, { capabilities: [], displayName: "Card", skills: [] })).rejects.toMatchObject({ code: "partner_card_kind_invalid" });
    expect(await service.update(partner.partnerId, { capabilities: ["new"], displayName: "Updated", promptRef: "prompt", skills: ["skill"], tools: ["tool"], workspaceRef: "new" }))
      .toMatchObject({ capabilities: ["new"], displayName: "Updated", skills: ["skill"], tools: ["tool"] });
  });

  it("persists local prompt bodies behind immutable private references", async () => {
    const prompts = new MemoryPartnerPrompts();
    const repository = new MemoryPartnerRegistry();
    const service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), prompts, repository });

    const partner = await service.add({
      capabilities: ["code"], displayName: "Coder", kind: "local-pi", prompt: "  Work only inside the assigned repository.  ",
      skills: [], tools: ["read"], workspaceRef: "workspace",
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
});
