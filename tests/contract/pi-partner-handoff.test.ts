/* Deterministic runtime adapters preserve asynchronous port shapes. */
/* eslint-disable @typescript-eslint/require-await */
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";

describe("Pi semantic completion handoff", () => {
  it("PI-SESSION-11 preserves optional structured metadata alongside the settled final answer", async () => {
    const faux = fauxProvider({ provider: "optional-work-handoff" }), models = createModels();models.setProvider(faux.provider);
    const handoff = { version: 1,conclusion: "PRIVATE_CONCLUSION",requirementIds: ["req-1"],evidenceResultIds: ["result-1"],artifactRefs: [],unresolved: ["PRIVATE_GAP"],conflicts: ["PRIVATE_CONFLICT"] };
    faux.setResponses([fauxAssistantMessage([fauxToolCall("work_handoff",handoff)],{ stopReason: "toolUse" }),fauxAssistantMessage([fauxText("Public delivery")])]);
    const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {} }) },prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
    const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-17T00:00:00Z",displayName: "Partner",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
    const events: unknown[] = [];
    const result = await runtime.runEphemeral({ actionId: "a",workbenchId: "wb",workId: "w",contextSnapshotId: "c",taskProjection: "Deliver" },revision,{ knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],onEvent: async event => { events.push(event); } });
    expect(result.output).toMatchObject({ body: "Public delivery",handoffStatus: "PROVIDED",handoff });
    expect(faux.state.callCount).toBe(2);
    expect(JSON.stringify({ events,conversation: result.conversation })).not.toMatch(/PRIVATE_CONCLUSION|PRIVATE_GAP|PRIVATE_CONFLICT/u);
  });
  it.each(["ephemeral", "resident"] as const)("PI-SESSION-07 delivers a settled %s answer without a mandatory handoff tool", async mode => {
    const faux = fauxProvider({ provider: `handoff-${mode}` });
    const models = createModels(); models.setProvider(faux.provider);
    let calls = 0;
    faux.setResponses([() => {
      calls += 1;
      return fauxAssistantMessage([fauxText("Complete user deliverable")]);
    }]);
    const runtime = new PiPartnerEngineRuntime({
      contexts: { loadForExecution: async () => ({ promptSection: "", sanitized: {} }) },
      prompts: { read: async () => null },
      resolver: { resolve: async () => ({ model: faux.getModel(), models, thinkingLevel: "off" as const }) },
      sources: { selectInitial: async turnId => ({ turnId, modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr" }) },
      tools: { names: ["read"], create: () => [{ name: "read", label: "read", description: "read", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text" as const, text: "unused" }], details: {} }) }] },
    });
    const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-10-19T00:00:00Z", displayName: "Partner", kind: "local-pi",
      partnerId: "partner", partnerRevisionId: "revision", registryRevision: 1, skills: [], tools: ["read"], toolPolicyMode: "CUSTOM" });
    const request = { actionId: "action", workbenchId: "wb", workId: "work", contextSnapshotId: "snapshot", taskProjection: "Finish the work",
      ...(mode === "resident" ? { workspaceExecution: { accessCeiling: "READ" as const, generation: 1, phase: "READ_RUNNING" as const } } : {}) };
    const events: unknown[] = [];
    const context = { knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [], onEvent: async (event: unknown) => { events.push(event); } };
    try {
      const result = mode === "ephemeral" ? await runtime.runEphemeral(request, revision, context)
        : await runtime.runResidentTurn({ ...context, instanceId: "handoff-instance", restoredMessages: null, request, revision });
      expect(calls).toBe(1);
      expect(result).toMatchObject({ status: "COMPLETED", output: { body: "Complete user deliverable", handoffStatus: "MISSING" } });
      const visible = JSON.stringify({ events, conversation: result.conversation });
      expect(visible).toContain("Complete user deliverable");
      expect(visible).not.toMatch(/PRIVATE_CONCLUSION|PRIVATE_GAP|PRIVATE_CONFLICT/u);
    } finally { runtime.evictFromMemory("handoff-instance"); }
  });
});
