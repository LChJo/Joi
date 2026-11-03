import { createPartnerEvidenceTools } from "../../src/main/infrastructure/pi/pi-evidence-tools.js";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { PiCodingPartnerRunner } from "../../src/main/infrastructure/pi/pi-coding-partner-runner.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";

describe("AC-48/53 Pi task-scoped evidence pages", () => {
  it("keeps mandatory requirements and pageable evidence available in the legacy Pi adapter", async () => {
    const faux = fauxProvider({ provider: "legacy-evidence" });
    const models = createModels(); models.setProvider(faux.provider);
    const contextRequests: unknown[] = [];
    const runner = new PiCodingPartnerRunner({
      contexts: { loadForExecution: (id,options) => { contextRequests.push([id,options]); return Promise.resolve({ promptSection: "", sanitized: {}, evidence: {
        index: JSON.stringify({ results: [{ resultId: "r", file: "result-0.txt" }], conclusions: [] }), files: [{ name: "result-0.txt", body: "FULL_EVIDENCE_TAIL" }], inline: "",
      } }); } },
      prompts: { read: () => Promise.resolve(null) },
      resolver: { resolve: () => Promise.resolve({ model: faux.getModel(), models, thinkingLevel: "high" as const }) },
      sources: { selectInitial: turnId => Promise.resolve({ turnId, modelId: "m", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr" }) },
      tools: { create: () => [], names: [] },
    });
    faux.setResponses([
      context => { expect(JSON.stringify(context).includes("MANDATORY_REQUIREMENTS")).toBe(true); return fauxAssistantMessage([fauxToolCall("work_read_result", { resultId: "r" })], { stopReason: "toolUse" }); },
      context => { expect(JSON.stringify(context.messages.at(-1))).toContain("FULL_EVIDENCE_TAIL"); return fauxAssistantMessage([fauxText("done")]); },
    ]);
    const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-10-19T00:00:00Z", displayName: "Reader", kind: "local-pi", partnerId: "p", partnerRevisionId: "pr", registryRevision: 1, skills: [], tools: [] });
    const result = await runner.run({ actionId: "a", workId: "w", workbenchId: "wb", contextSnapshotId: "snapshot", taskProjection: "Read evidence", requiredContext: "MANDATORY_REQUIREMENTS" }, revision);
    expect(result.status).toBe("COMPLETED");
    expect(contextRequests).toEqual([["snapshot",{ evidenceMode: "LAZY" }]]);
  });
  it("refreshes evidence readers at each warm Work boundary and rejects identifiers from another goal", async () => {
    const faux = fauxProvider({ provider: "warm-evidence" });
    const models = createModels(); models.setProvider(faux.provider);
    const contextRequests: unknown[] = [];
    const evidence = (id: string) => ({ index: JSON.stringify({ results: [{ resultId: id, file: "result-0.txt" }], conclusions: [] }), files: [{ name: "result-0.txt", body: `BODY_${id}` }], inline: "" });
    const runtime = new PiPartnerEngineRuntime({
      contexts: { loadForExecution: (id,options) => { contextRequests.push([id,options]); return Promise.resolve({ promptSection: "", sanitized: {}, evidence: evidence(id) }); } },
      prompts: { read: () => Promise.resolve(null) },
      resolver: { resolve: () => Promise.resolve({ model: faux.getModel(), models, thinkingLevel: "off" as const }) },
      sources: { selectInitial: turnId => Promise.resolve({ turnId, modelId: "m", modelRevisionId: "mr", sourceId: "s", sourceRevisionId: "sr" }) },
      tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-10-19T00:00:00Z", displayName: "Reader", kind: "local-pi", partnerId: "p", partnerRevisionId: "pr", registryRevision: 1, skills: [], tools: [] });
    const turn = (id: string) => runtime.runResidentTurn({ instanceId: "instance", revision, restoredMessages: null, knowledgeSection: "", skillSection: "", skillEnvironmentKeys: [], request: { actionId: id, workId: id, workbenchId: "wb", contextSnapshotId: id, taskProjection: `Read ${id}` } });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("work_read_result", { resultId: "goal1" })], { stopReason: "toolUse" }),
      context => { expect(JSON.stringify(context.messages.at(-1))).toContain("BODY_goal1"); return fauxAssistantMessage([fauxText("first done")]); },
    ]);
    await turn("goal1");
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("context_read_history", {})], { stopReason: "toolUse" }),
      context => { expect(JSON.stringify(context.messages.at(-1)).includes("BODY_goal1")).toBe(false); return fauxAssistantMessage([fauxToolCall("work_read_result", { resultId: "goal1" })], { stopReason: "toolUse" }); },
      context => { expect(context.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true }); return fauxAssistantMessage([fauxToolCall("work_read_result", { resultId: "goal2" })], { stopReason: "toolUse" }); },
      context => { expect(JSON.stringify(context.messages.at(-1))).toContain("BODY_goal2"); expect(JSON.stringify(context.messages.at(-1))).not.toContain("BODY_goal1"); return fauxAssistantMessage([fauxText("second done")]); },
    ]);
    await turn("goal2");
    expect(contextRequests).toEqual([["goal1",{ evidenceMode: "LAZY" }],["goal2",{ evidenceMode: "LAZY" }]]);
    runtime.evictFromMemory("instance");
  });
  it("reads all index, result and conclusion pages without accepting caller-selected scopes", async () => {
    const text = "middle evidence ".repeat(1200) + "CONCLUSION_TAIL";
    const evidence = {
      index: JSON.stringify({ results: [{ resultId: "r", file: "result-0.txt", status: "FAILED", isLate: true, verificationStatus: "UNVERIFIED" }], conclusions: [{ outcomeId: "o", file: "conclusion-0.txt" }] }),
      files: [{ name: "result-0.txt", body: text }, { name: "conclusion-0.txt", body: text }], inline: "",
    };
    const tools = createPartnerEvidenceTools(evidence);
    const read = async (name: string, args: unknown) => {
      const tool = tools.find(item => item.name === name);
      const result = await tool?.execute("call", args);
      return JSON.parse((result?.content[0] as { text: string }).text) as { content: string; nextCursor?: string; totalCharacters: number };
    };
    expect((await read("work_read_evidence", {})).content).toContain("UNVERIFIED");
    let cursor: string | undefined;
    let body = "";
    do {
      const page = await read("work_read_result", { resultId: "r", cursor });
      expect(page.content.length).toBeLessThanOrEqual(8000);
      body += page.content; cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(body).toBe(text);
    expect(await read("work_read_evidence", { mode: "conclusion", outcomeId: "o", cursor: "16000" })).toMatchObject({ content: text.slice(16000, 24000) });
    await expect(read("work_read_result", { resultId: "foreign", workbenchId: "other", goalInputId: "other" })).rejects.toMatchObject({ code: "goal_evidence_not_found" });
    await expect(read("work_read_result", { resultId: "r", cursor: "-1" })).rejects.toMatchObject({ code: "work_result_cursor_invalid" });
    expect(createPartnerEvidenceTools(undefined)).toEqual([]);
  });
});
