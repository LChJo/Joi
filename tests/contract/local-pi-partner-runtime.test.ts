/* Faux Pi provider callbacks resolve deterministically in contract tests. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";

import { PiCodingPartnerRunner } from "../../src/main/infrastructure/pi/pi-coding-partner-runner.js";
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
      tools: { create: () => [] },
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
