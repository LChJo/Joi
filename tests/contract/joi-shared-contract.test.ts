import {
  MODEL_SOURCE_CHOICES,
  MODEL_SOURCE_KINDS,
  type AvatarDto,
  type JoiSnapshotDto,
  type ModelSourceDto,
  type PartnerDto,
} from "../../src/shared/joi.js";

describe("JOI-01 shared DTO contract", () => {
  it("exposes Avatar, Partner and model source projections without secret or absolute-path fields", () => {
    expect(MODEL_SOURCE_KINDS).toEqual(["kimi", "glm", "qwen", "doubao", "minimax", "deepseek", "generic-openai"]);
    expect(MODEL_SOURCE_CHOICES.find((choice) => choice.kind === "kimi")?.options.map((option) => option.accessMode))
      .toEqual(["api", "coding-plan"]);
    expect(MODEL_SOURCE_CHOICES.find((choice) => choice.kind === "kimi")?.options[1]?.protocols.map((option) => option.protocol))
      .toEqual(["openai", "anthropic"]);
    expect(MODEL_SOURCE_CHOICES.find((choice) => choice.kind === "qwen")?.options.map((option) => (
      option.protocols.map((protocol) => protocol.protocol)
    ))).toEqual([["openai", "anthropic"], ["openai", "anthropic"]]);
    expect(MODEL_SOURCE_CHOICES.find((choice) => choice.kind === "deepseek")?.options.map((option) => option.accessMode))
      .toEqual(["api"]);
    expect(MODEL_SOURCE_CHOICES.find((choice) => choice.kind === "deepseek")?.options[0]?.protocols.map((option) => option.protocol))
      .toEqual(["openai"]);
    expect(MODEL_SOURCE_CHOICES.find((choice) => choice.kind === "generic-openai")?.options[0]?.protocols.map((option) => option.protocol))
      .toEqual(["openai", "anthropic"]);
    const avatar: AvatarDto = {
      avatarId: "avatar_1",
      name: "产品工作",
      scopeSummary: "joi 工程",
      updatedAt: "2026-07-28T10:00:00.000Z",
    };
    const partner: PartnerDto = {
      capabilities: ["research"],
      createdBy: "user",
      displayName: "Researcher",
      engine: "pi-core",
      inFlightCount: 0,
      kind: "a2a",
      knowledgeDocCount: 0,
      lifecyclePolicy: "DRAIN",
      partnerId: "partner_1",
      partnerRevisionId: "partner_rev_1",
      registryRevision: 1,
      skills: ["search"],
      status: "ACTIVE",
      tools: ["web.search"],
    };
    const source: ModelSourceDto = {
      accessMode: "coding-plan",
      activeModel: { capability: "release-tested", id: "kimi-k2.5", revisionId: "model_rev_1" },
      activeSourceRevisionId: "source_rev_1",
      credential: { configured: true, version: 1 },
      displayName: "主 Kimi",
      kind: "kimi",
      order: 0,
      primary: true,
      protocol: "anthropic",
      sourceId: "source_1",
      status: "READY",
    };
    const snapshot: JoiSnapshotDto = {
      avatarChanges: [],
      avatars: [avatar],
      modelSources: [source],
      partners: [partner],
      runtime: { configured: true, status: "READY" },
      work: [],
    };

    const serialized = JSON.stringify(snapshot);
    for (const forbidden of ["apiKey", "credentialRef", "promptRef", "workspaceRef", "absolutePath", "encryptedBlob"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});
