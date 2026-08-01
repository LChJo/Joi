/* Faux Pi provider callbacks resolve deterministically in contract tests. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

import { PiCodingPartnerRunner } from "../../src/main/infrastructure/pi/pi-coding-partner-runner.js";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";

describe("local Pi coding partner runtime", () => {
  it("runs one isolated Pi session with the pinned workspace, prompt and tool allowlist", async () => {
    const faux = fauxProvider({ provider: "local-partner" });
    faux.setResponses([fauxAssistantMessage([fauxText("work completed")])]);
    const models = createModels();
    models.setProvider(faux.provider);
    const toolRequests: { cwd: string; names: string[] }[] = [];
    const runner = new PiCodingPartnerRunner({
      prompts: { read: async (promptRef) => promptRef === "prompt_ref_1" ? "LOCAL_PARTNER_SYSTEM_SENTINEL" : null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: {
        create: (cwd, names) => { toolRequests.push({ cwd, names }); return []; },
        names: ["read", "edit", "bash", "write", "grep", "find", "ls"],
      },
    });
    const revision = createPartnerRevision({
      capabilities: ["code"],
      createdAt: "2026-07-28T12:00:00.000Z",
      displayName: "Local coder",
      kind: "local-pi",
      partnerId: "partner_local",
      partnerRevisionId: "partner_revision_local",
      promptRef: "prompt_ref_1",
      registryRevision: 1,
      skills: ["typescript"],
      tools: ["read", "edit"],
      workspaceRef: "workspace_ref_1",
    });

    await expect(runner.run({
      actionId: "action_1",
      avatarId: "avatar_1",
      taskProjection: "Implement the verified change.",
      workId: "work_1",
    }, revision)).resolves.toEqual({ externalRunId: "local_pi:action_1", status: "COMPLETED" });
    expect(toolRequests).toEqual([{ cwd: "workspace_ref_1", names: ["read", "edit"] }]);
  });

  it("fails closed when the prompt reference cannot be resolved", async () => {
    const runner = new PiCodingPartnerRunner({
      prompts: { read: async () => null },
      resolver: { resolve: async () => { throw new Error("must not resolve"); } },
      sources: { selectInitial: async () => { throw new Error("must not select"); } },
      tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Local", kind: "local-pi",
      partnerId: "partner", partnerRevisionId: "revision", promptRef: "missing", registryRevision: 1,
      skills: [], tools: [], workspaceRef: "workspace",
    });
    await expect(runner.run({ actionId: "action", avatarId: "avatar", taskProjection: "task", workId: "work" }, revision))
      .rejects.toThrow("partner_prompt_not_found");
  });
});

describe("Pi partner engine runtime", () => {
  it("continues a resident conversation across turns, rebuilds after eviction and keeps ephemeral runs isolated", async () => {
    const faux = fauxProvider({ provider: "local-partner-instances" });
    faux.setResponses([
      fauxAssistantMessage([fauxText("first answer")]),
      fauxAssistantMessage([fauxText("second answer")]),
      fauxAssistantMessage([fauxText("ephemeral answer")]),
      fauxAssistantMessage([fauxText("rebuilt answer")]),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const runtime = new PiPartnerEngineRuntime({
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models }) },
      sources: { selectInitial: async (turnId) => ({ modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId }) },
      tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({
      capabilities: [], createdAt: "2026-07-28T12:00:00.000Z", displayName: "Local", kind: "local-pi",
      partnerId: "partner_local", partnerRevisionId: "partner_revision_local", registryRevision: 1,
      skills: [], tools: [], workspaceRef: "workspace_ref_1",
    });
    const request = { actionId: "action_1", avatarId: "avatar_1", taskProjection: "first task", workId: "work_1" };

    const first = await runtime.runResidentTurn({ instanceId: "instance_1", knowledgeSection: "KB_SECTION", request, restoredMessages: null, revision, skillSection: "" });
    expect(first.status).toBe("COMPLETED");
    expect(first.externalSessionRef).toBe("partner_instance_messages:instance_1");

    const second = await runtime.runResidentTurn({
      instanceId: "instance_1", knowledgeSection: "KB_SECTION",
      request: { ...request, actionId: "action_2", taskProjection: "second task" },
      restoredMessages: first.messages,
      revision,
      skillSection: "",
    });
    expect(second.messages.length).toBeGreaterThan(first.messages.length);

    const ephemeral = await runtime.runEphemeral(
      { actionId: "action_3", avatarId: "avatar_1", taskProjection: "one shot", workId: "work_3" },
      revision,
      { knowledgeSection: "", skillSection: "" },
    );
    expect(ephemeral).toEqual({ externalRunId: "local_pi:action_3", status: "COMPLETED" });

    runtime.evictFromMemory("instance_1");
    const rebuilt = await runtime.runResidentTurn({
      instanceId: "instance_1", knowledgeSection: "KB_SECTION",
      request: { ...request, actionId: "action_4", taskProjection: "after eviction" },
      restoredMessages: second.messages,
      revision,
      skillSection: "",
    });
    expect(rebuilt.status).toBe("COMPLETED");
    expect(rebuilt.messages.length).toBeGreaterThan(second.messages.length);

    expect(runtime.engineOf()).toBe("pi-core");
    await expect(runtime.health()).resolves.toEqual({ available: true });
  });
});
