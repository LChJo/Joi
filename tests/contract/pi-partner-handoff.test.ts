/* Deterministic runtime adapters preserve asynchronous port shapes. */
/* eslint-disable @typescript-eslint/require-await */
import { Type } from "typebox";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";

describe("Pi semantic completion handoff", () => {
  it.each(["ephemeral", "resident"] as const)("delivers body and handoff in one %s final tool call without leaking private fields", async mode => {
    const faux = fauxProvider({ provider: `handoff-${mode}` });
    const models = createModels(); models.setProvider(faux.provider);
    let calls = 0;
    const handoff = { version: 1, conclusion: "PRIVATE_CONCLUSION", requirementIds: ["req-1"], evidenceResultIds: [],
      artifactRefs: [], unresolved: ["PRIVATE_GAP"], conflicts: ["PRIVATE_CONFLICT"] };
    faux.setResponses([() => {
      calls += 1;
      return fauxAssistantMessage([fauxToolCall("partner_complete", { body: "Complete user deliverable", handoff })], { stopReason: "toolUse" });
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
      expect(result).toMatchObject({ status: "COMPLETED", output: { body: "Complete user deliverable", handoff, handoffStatus: "PROVIDED" } });
      const visible = JSON.stringify({ events, conversation: result.conversation });
      expect(visible).toContain("Complete user deliverable");
      expect(visible).not.toMatch(/PRIVATE_CONCLUSION|PRIVATE_GAP|PRIVATE_CONFLICT/u);
    } finally { runtime.evictFromMemory("handoff-instance"); }
  });
});
