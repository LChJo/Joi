import {
  createWorkbench,
  updateWorkbenchProfile,
} from "../../src/main/domain/workbench/workbench.js";
import {
  classifySourceFailure,
  createModelSource,
  pinModelSourceForTurn,
  reviseModelSource,
} from "../../src/main/domain/model-sources/model-source.js";
import {
  createPartnerRevision,
  mergeA2aCardRevision,
  toPublicPartner,
} from "../../src/main/domain/partners/partner.js";

describe("JOI-01 pure domain", () => {
  it("keeps legacy non-empty local tool lists narrowed when no mode is supplied", () => {
    expect(createPartnerRevision({
      capabilities: [],
      createdAt: "2026-09-03T10:00:00.000Z",
      displayName: "Legacy local",
      kind: "local-pi",
      partnerId: "partner_legacy",
      partnerRevisionId: "revision_legacy",
      registryRevision: 1,
      skills: [],
      tools: ["read"],
    }).toolPolicyMode).toBe("CUSTOM");
  });

  it("keeps Workbench as context only and creates immutable profile revisions", () => {
    const workbench = createWorkbench({
      workbenchId: "workbench_1",
      createdAt: "2026-07-28T10:00:00.000Z",
      memoryNamespaceId: "memory_workbench_1",
      name: "  产品工作  ",
      personaRevisionId: "persona_1",
      personaSummary: "  关注产品与交付  ",
      project: { label: "joi" },
      scopeSummary: "  joi 工程  ",
      taskContext: { activeWorkIds: ["work_1"], summary: "当前里程碑" },
    });

    expect(workbench).toEqual({
      workbenchId: "workbench_1",
      createdAt: "2026-07-28T10:00:00.000Z",
      memory: { namespaceId: "memory_workbench_1" },
      profile: {
        name: "产品工作",
        personaRevisionId: "persona_1",
        personaSummary: "关注产品与交付",
        scopeSummary: "joi 工程",
      },
      project: { label: "joi" },
      taskContext: { activeWorkIds: ["work_1"], summary: "当前里程碑" },
      updatedAt: "2026-07-28T10:00:00.000Z",
    });
    expect(Object.keys(workbench)).not.toEqual(expect.arrayContaining(["agent", "budget", "runtime", "scheduler", "state"]));

    const updated = updateWorkbenchProfile(workbench, {
      name: "产品与工程",
      personaRevisionId: "persona_2",
      personaSummary: "关注可验证交付",
      updatedAt: "2026-07-28T10:01:00.000Z",
    });
    expect(updated.profile.personaRevisionId).toBe("persona_2");
    expect(workbench.profile.personaRevisionId).toBe("persona_1");
    expect(updated.project).toEqual(workbench.project);
    expect(updateWorkbenchProfile(workbench, {
      name: "产品与工程",
      personaRevisionId: "persona_3",
      personaSummary: "关注新范围",
      scopeSummary: "发布验证",
      updatedAt: "2026-07-28T10:02:00.000Z",
    }).profile.scopeSummary).toBe("发布验证");
  });

  it("omits blank Workbench workspace references and preserves scope when an update does not replace it", () => {
    const workbench = createWorkbench({
      workbenchId: "workbench_without_workspace",
      createdAt: "2026-07-28T10:00:00.000Z",
      memoryNamespaceId: "memory_workbench_without_workspace",
      name: "General",
      personaRevisionId: "persona_1",
      personaSummary: "General context",
      project: { label: "Inbox" },
      scopeSummary: "Original scope",
      taskContext: { activeWorkIds: ["work_1", "work_1"], summary: "  queued  " },
    });

    expect(workbench.project).toEqual({ label: "Inbox" });
    expect(workbench.taskContext).toEqual({ activeWorkIds: ["work_1"], summary: "queued" });
    expect(updateWorkbenchProfile(workbench, {
      name: "General updated",
      personaRevisionId: "persona_2",
      personaSummary: "Updated context",
      updatedAt: "2026-07-28T10:01:00.000Z",
    }).profile.scopeSummary).toBe("Original scope");

    expect(() => createWorkbench({
      workbenchId: " ",
      createdAt: "2026-07-28T10:00:00.000Z",
      memoryNamespaceId: "memory_invalid",
      name: "Invalid",
      personaRevisionId: "persona_1",
      personaSummary: "Invalid workbench",
      project: { label: "Inbox" },
      scopeSummary: "Invalid scope",
      taskContext: { activeWorkIds: [], summary: "" },
    })).toThrow(/Workbench context value is invalid/i);
    expect(() => createWorkbench({
      workbenchId: "workbench_too_long_name",
      createdAt: "2026-07-28T10:00:00.000Z",
      memoryNamespaceId: "memory_invalid",
      name: "x".repeat(81),
      personaRevisionId: "persona_1",
      personaSummary: "Invalid workbench",
      project: { label: "Inbox" },
      scopeSummary: "Invalid scope",
      taskContext: { activeWorkIds: [], summary: "" },
    })).toThrow(/Workbench context value is invalid/i);
  });

  it("creates immutable source/model revisions and pins both for a Turn", () => {
    const source = createModelSource({
      createdAt: "2026-07-28T10:00:00.000Z",
      credentialRef: "credential_source_1",
      credentialVersion: 1,
      displayName: "主 Kimi",
      kind: "kimi",
      modelCapability: "release-tested",
      modelId: "kimi-k2.5",
      modelRevisionId: "model_rev_1",
      sourceId: "source_1",
      sourceRevisionId: "source_rev_1",
    });
    const revised = reviseModelSource(source, {
      credentialVersion: 2,
      modelCapability: "custom-unverified-tools",
      modelId: "kimi-custom",
      modelRevisionId: "model_rev_2",
      sourceRevisionId: "source_rev_2",
      updatedAt: "2026-07-28T10:01:00.000Z",
    });

    expect(source.activeSourceRevision.sourceRevisionId).toBe("source_rev_1");
    expect(source.activeModelRevision.modelRevisionId).toBe("model_rev_1");
    expect(revised.activeSourceRevision.sourceRevisionId).toBe("source_rev_2");
    expect(revised.activeModelRevision).toMatchObject({
      capability: "custom-unverified-tools",
      modelId: "kimi-custom",
      modelRevisionId: "model_rev_2",
    });
    expect(pinModelSourceForTurn(revised, "turn_1")).toEqual({
      modelCapability: "custom-unverified-tools",
      modelId: "kimi-custom",
      modelRevisionId: "model_rev_2",
      sourceId: "source_1",
      sourceRevisionId: "source_rev_2",
      toolCapabilityProven: false,
      turnId: "turn_1",
    });
    expect(pinModelSourceForTurn({ ...revised, toolProofAt: "2026-07-28T10:02:00.000Z" }, "turn_1")).toMatchObject({
      toolCapabilityProven: true,
    });
    expect(() => createModelSource({
      createdAt: "2026-07-28T10:00:00.000Z", credentialRef: "credential_invalid", credentialVersion: 0,
      displayName: "Invalid", kind: "kimi", modelCapability: "release-tested", modelId: "kimi-k2.5",
      modelRevisionId: "model_invalid", sourceId: "source_invalid", sourceRevisionId: "source_invalid_revision",
    })).toThrow(/Credential version is invalid/i);
    expect(() => reviseModelSource(source, {
      credentialVersion: 2, modelCapability: "release-tested", modelId: "kimi-k2.5", modelRevisionId: "model_rev_new",
      sourceRevisionId: "source_rev_1", updatedAt: "2026-07-28T10:02:00.000Z",
    })).toThrow(/revisions must be immutable/i);
    expect(() => reviseModelSource(source, {
      credentialVersion: 2, modelCapability: "release-tested", modelId: "kimi-k2.5", modelRevisionId: "model_rev_1",
      sourceRevisionId: "source_rev_new", updatedAt: "2026-07-28T10:02:00.000Z",
    })).toThrow(/revisions must be immutable/i);
  });

  it("classifies only recoverable infrastructure failures for deterministic fallback", () => {
    for (const failure of ["timeout", "connect", "rate_limited", "server_error"] as const) {
      expect(classifySourceFailure(failure)).toEqual({ fallbackAllowed: true, sourceNeedsAttention: false });
    }
    for (const failure of ["auth", "balance", "configuration"] as const) {
      expect(classifySourceFailure(failure)).toEqual({ fallbackAllowed: false, sourceNeedsAttention: true });
    }
    for (const failure of ["safety_refusal", "content_refusal"] as const) {
      expect(classifySourceFailure(failure)).toEqual({ fallbackAllowed: false, sourceNeedsAttention: false });
    }
  });

  it("increments partner revisions without letting Card data overwrite local policy", () => {
    const first = createPartnerRevision({
      capabilities: ["research"],
      createdAt: "2026-07-28T10:00:00.000Z",
      displayName: "Researcher",
      kind: "a2a",
      partnerId: "partner_1",
      partnerRevisionId: "partner_rev_1",
      promptRef: "prompt_ref_local",
      registryRevision: 1,
      skills: ["search"],
      tools: ["web.search"],
    });
    const second = mergeA2aCardRevision(first, {
      card: {
        capabilities: ["research", "summarize"],
        displayName: "Remote renamed",
        skills: ["search", "summarize"],
        tools: ["remote.tool"],
      },
      createdAt: "2026-07-28T10:01:00.000Z",
      partnerRevisionId: "partner_rev_2",
      registryRevision: 2,
    });

    expect(first.partnerRevisionId).toBe("partner_rev_1");
    expect(second).toMatchObject({
      capabilities: ["research", "summarize"],
      displayName: "Remote renamed",
      partnerRevisionId: "partner_rev_2",
      promptRef: "prompt_ref_local",
      registryRevision: 2,
      tools: ["web.search"],
    });
    expect(toPublicPartner(second)).toEqual({
      capabilities: ["research", "summarize"],
      createdBy: "user",
      displayName: "Remote renamed",
      engine: "pi-core",
      kind: "a2a",
      partnerId: "partner_1",
      partnerRevisionId: "partner_rev_2",
      promptConfigured: true,
      registryRevision: 2,
      skills: ["search", "summarize"],
      status: "ACTIVE",
      tools: ["web.search"],
    });
  });

  it("rejects invalid partner revisions and Card updates for local partners", () => {
    expect(() => createPartnerRevision({
      capabilities: [],
      createdAt: "2026-07-28T10:00:00.000Z",
      displayName: "Local",
      kind: "local-pi",
      partnerId: "partner_local",
      partnerRevisionId: "partner_rev_1",
      registryRevision: 0,
      skills: [],
      tools: [],
    })).toThrow(/registry revision/i);

    const local = createPartnerRevision({
      capabilities: [],
      createdAt: "2026-07-28T10:00:00.000Z",
      displayName: "Local",
      kind: "local-pi",
      partnerId: "partner_local",
      partnerRevisionId: "partner_rev_1",
      registryRevision: 1,
      skills: [],
      tools: [],
    });
    expect(() => mergeA2aCardRevision(local, {
      card: { capabilities: [], displayName: "ignored", skills: [] },
      createdAt: "2026-07-28T10:01:00.000Z",
      partnerRevisionId: "partner_rev_2",
      registryRevision: 2,
    })).toThrow(/Only A2A/i);

    const remote = createPartnerRevision({
      capabilities: [],
      createdAt: "2026-07-28T10:00:00.000Z",
      displayName: "Remote",
      kind: "a2a",
      partnerId: "partner_remote",
      partnerRevisionId: "partner_rev_1",
      registryRevision: 1,
      skills: [],
      tools: [],
    });
    expect(() => mergeA2aCardRevision(remote, {
      card: { capabilities: [], displayName: "Remote", skills: [] },
      createdAt: "2026-07-28T10:01:00.000Z",
      partnerRevisionId: "partner_rev_stale",
      registryRevision: 1,
    })).toThrow(/must increase/i);
  });
});
