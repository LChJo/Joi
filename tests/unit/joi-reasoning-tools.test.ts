/* eslint-disable @typescript-eslint/require-await */
import { createJoiReasoningTools } from "../../src/main/infrastructure/pi/joi-reasoning-tools.js";
import type { ModelSourceDto, PartnerDto } from "../../src/shared/joi.js";

const partnerDto: PartnerDto = {
  capabilities: ["code"], createdBy: "user", displayName: "Coder", engine: "pi-core", inFlightCount: 0,
  kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN", partnerId: "partner_1",
  partnerRevisionId: "partner_revision_1", registryRevision: 1, skills: [], status: "ACTIVE", tools: ["read"],
};

const readySource: ModelSourceDto = {
  accessMode: "api", activeModel: { capability: "release-tested", id: "kimi-k2.5", revisionId: "model_r" },
  activeSourceRevisionId: "source_revision_r", credential: { configured: true, version: 1 }, displayName: "Kimi",
  kind: "kimi", order: 0, primary: true, protocol: "anthropic", sourceId: "source_ready", status: "READY",
};
const draftSource: ModelSourceDto = { ...readySource, displayName: "Draft", primary: false, sourceId: "source_draft", status: "DRAFT" };

const instanceRecord = {
  avatarId: "avatar_1", createdAt: "2026-07-29T10:00:00.000Z", engine: "pi-core" as const, instanceId: "instance_1",
  lastUsedAt: "2026-07-29T10:00:00.000Z", partnerId: "partner_1", partnerRevisionId: "partner_revision_1",
  sessionPolicy: "RESIDENT" as const, status: "IDLE" as const,
};

function makeTools() {
  const addCalls: unknown[] = [];
  const ensureCalls: unknown[] = [];
  const disposeCalls: { instanceId: string; reason: string }[] = [];
  const planCalls: unknown[] = [];
  const changeBase = { createdAt: "2026-07-29T10:00:00.000Z", requestId: "change_1", status: "PENDING" as const };
  const tools = createJoiReasoningTools({
    avatarId: "avatar_1",
    avatarChanges: {
      suggestArchive: async (input) => ({ ...changeBase, ...input, kind: "ARCHIVE" as const, sourceAvatarId: input.avatarId }),
      suggestMerge: async (input) => ({ ...changeBase, ...input, kind: "MERGE" as const }),
    },
    avatars: { getAvatar: async () => null, listSummaries: async () => [] },
    instances: {
      dispose: async ({ instanceId, reason }) => { disposeCalls.push({ instanceId, reason }); },
      ensure: async (input) => { ensureCalls.push(input); return instanceRecord; },
      list: async () => [instanceRecord],
    },
    memory: { digest: async () => ({ last3: [{ at: "2026-07-29T10:00:00.000Z", outcome: "COMPLETED" as const, title: "old task" }], successRate: 0.5, summary: "DIGEST_SUMMARY" }) },
    models: { list: async () => [readySource, draftSource] },
    partners: {
      add: async (input) => { addCalls.push(input); return partnerDto; },
      inspect: async () => partnerDto,
      list: async () => [partnerDto],
    },
    results: { read: async ({ resultId }) => ({ content: "result", resultId }) },
    turnId: "turn_1",
    work: {
      plan: async (input) => { planCalls.push(input); return { dispatchPlanId: "plan_1", waves: [] }; },
      reassign: async (input) => ({
        ...input,
        actionId: "action_r",
        dispatchAttemptId: "attempt_r",
        outbox: {
          availableAt: "2026-07-29T10:00:00.000Z",
          kind: "partner.dispatch" as const,
          outboxId: "outbox_r",
          payload: { actionId: "action_r", dispatchAttemptId: "attempt_r", workId: input.workId },
        },
        partnerRevisionId: "partner_revision_1",
        registryRevision: 1,
      }),
    },
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    async call(name: string, args: Record<string, unknown>): Promise<unknown> {
      const tool = byName.get(name);
      if (tool === undefined) throw new Error(`missing tool ${name}`);
      const output = await tool.execute("tool_call_1", args) as { content: { text: string }[] };
      return JSON.parse(output.content[0]?.text ?? "null") as unknown;
    },
    addCalls,
    disposeCalls,
    ensureCalls,
    planCalls,
  };
}

describe("joi reasoning tools", () => {
  it("creates partners on behalf of joi with the joi creator badge", async () => {
    const harness = makeTools();
    const created = await harness.call("partner.create", { description: "写文档", displayName: "Writer" }) as { partnerId: string };
    expect(created.partnerId).toBe("partner_1");
    expect(harness.addCalls[0]).toMatchObject({ capabilities: [], createdBy: "joi", description: "写文档", kind: "local-pi", skills: [], tools: [] });
  });

  it("pins a chosen model source when creating a partner", async () => {
    const harness = makeTools();
    await harness.call("partner.create", { displayName: "Writer", modelIdOverride: "kimi-k2.5", modelSourceId: "source_ready" });
    expect(harness.addCalls[0]).toMatchObject({ createdBy: "joi", displayName: "Writer", modelIdOverride: "kimi-k2.5", modelSourceId: "source_ready" });
  });

  it("lists only READY model sources with the fields partner.create needs", async () => {
    const harness = makeTools();
    const sources = await harness.call("model.list_sources", {}) as unknown[];
    expect(sources).toEqual([{ displayName: "Kimi", kind: "kimi", modelId: "kimi-k2.5", primary: true, protocol: "anthropic", sourceId: "source_ready" }]);
  });

  it("creates, lists and disposes partner instances with explicit session policies", async () => {
    const harness = makeTools();
    const instance = await harness.call("partner.create_instance", { partnerId: "partner_1", sessionPolicy: "resident" });
    expect(harness.ensureCalls[0]).toMatchObject({ partnerId: "partner_1", sessionPolicy: "RESIDENT" });
    expect(instance).toMatchObject({ instanceId: "instance_1", sessionPolicy: "RESIDENT" });

    const listed = await harness.call("partner.list_instances", { partnerId: "partner_1" }) as unknown[];
    expect(listed).toHaveLength(1);

    await harness.call("partner.dispose_instance", { instanceId: "instance_1" });
    expect(harness.disposeCalls[0]).toEqual({ instanceId: "instance_1", reason: "joi disposed the instance" });
  });

  it("enriches partner.list_available with live instances and the working-memory digest", async () => {
    const harness = makeTools();
    const listed = await harness.call("partner.list_available", {}) as { activeInstanceCount: number; instances: unknown[]; memoryDigest: { summary: string } }[];
    expect(listed[0]).toMatchObject({
      activeInstanceCount: 1,
      displayName: "Coder",
      memoryDigest: { summary: "DIGEST_SUMMARY" },
      partnerId: "partner_1",
    });
    expect(listed[0]?.instances).toHaveLength(1);
  });

  it("inspects one redacted partner revision", async () => {
    const harness = makeTools();
    const inspected = await harness.call("partner.inspect_revision", { partnerId: "partner_1" }) as PartnerDto;
    expect(inspected).toMatchObject({ displayName: "Coder", partnerId: "partner_1" });
  });

  it("forwards instance targeting from work.dispatch into the work plan", async () => {
    const harness = makeTools();
    await harness.call("work.dispatch", {
      dependencies: [],
      work: [{ accessMode: "WRITE", instanceId: "instance_1", key: "w1", partnerId: "partner_1", sessionPolicy: "resident", title: "继续上次的会话" }],
    });
    const planned = (harness.planCalls[0] as { work: { instanceId?: string; sessionPolicy?: string }[] }).work;
    expect(planned[0]).toMatchObject({ instanceId: "instance_1", sessionPolicy: "RESIDENT" });
  });
});
