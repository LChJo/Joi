import {
  MODEL_SOURCE_KINDS,
  type AvatarDto,
  type JoiSnapshotDto,
  type ModelSourceDto,
  type PartnerDto,
} from "../../src/shared/joi.js";

describe("JOI-01 shared DTO contract", () => {
  it("exposes Avatar, Partner and model source projections without secret or absolute-path fields", () => {
    expect(MODEL_SOURCE_KINDS).toEqual(["kimi", "glm", "qwen", "doubao", "minimax", "deepseek", "generic-openai"]);
    const avatar: AvatarDto = {
      avatarId: "avatar_1",
      name: "产品工作",
      scopeSummary: "joi 工程",
      updatedAt: "2026-07-28T10:00:00.000Z",
    };
    const partner: PartnerDto = {
      capabilities: ["research"],
      displayName: "Researcher",
      inFlightCount: 0,
      kind: "a2a",
      lifecyclePolicy: "DRAIN",
      partnerId: "partner_1",
      partnerRevisionId: "partner_rev_1",
      registryRevision: 1,
      skills: ["search"],
      status: "ACTIVE",
      tools: ["web.search"],
    };
    const source: ModelSourceDto = {
      activeModel: { capability: "release-tested", id: "kimi-k2.5", revisionId: "model_rev_1" },
      activeSourceRevisionId: "source_rev_1",
      credential: { configured: true, version: 1 },
      displayName: "主 Kimi",
      kind: "kimi",
      order: 0,
      primary: true,
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
