/* Provider doubles return deterministic promises. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createPiContextManager } from "../../src/main/infrastructure/pi/pi-context-manager.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import type { JoiReasoningSessionSnapshot } from "../../src/main/application/ports/primary-reasoning-runtime.js";
import { boundRequestByChars } from "../../src/main/infrastructure/pi/pi-model-budget.js";
import { createContextHistoryTool } from "../../src/main/infrastructure/pi/pi-history-tools.js";

function fixture(provider: string) {
  const faux = fauxProvider({ provider });
  const models = createModels(); models.setProvider(faux.provider);
  return { faux, models, model: { ...faux.getModel(), contextWindow: 2_000_000 } };
}
function history(): AgentMessage[] {
  return [
    { role: "user", content: "MANDATORY_TASK", timestamp: 0 },
    ...Array.from({ length: 50 }, (_, index) => ({ role: "user" as const, content: `evidence-${String(index)} `.padEnd(4000, "x"), timestamp: index + 1 })),
  ];
}

describe("AC-43/48/53/67 context soft budget", () => {
  it("checkpoints a long joi tool loop before its next provider request without changing the stored transcript", async () => {
    const f = fixture("joi-midflight-soft");
    vi.spyOn(f.models, "completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("Sources 0 through 5 checked; keep pending gap.")]));
    const requests: string[] = [];
    f.faux.setResponses(Array.from({ length: 11 }, (_, index) => context => {
      requests.push(JSON.stringify(context.messages));
      return index < 10 ? fauxAssistantMessage([fauxToolCall("work_read_result", { resultId: String(index) })], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText("done")]);
    }));
    let snapshot: JoiReasoningSessionSnapshot | undefined;
    const runtime = new PiReasoningRuntime({ ...f, thinkingLevel: "high", tools: [{
      name: "work_read_result", label: "Read", description: "Read evidence", parameters: Type.Object({ resultId: Type.String() }),
      execute: async (_id, raw) => ({ content: [{ type: "text", text: `PAGE_${(raw as { resultId: string }).resultId} `.padEnd(20_000, "x") }], details: {} }),
    }], sessionStore: { load: async () => null, save: async value => { snapshot = value; } } });
    await runtime.startTurn({ workbenchId: "wb", sessionId: "loop", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "POLICY", inputId: "input", turnId: "turn", prompt: "CURRENT_TASK", requiredContext: "REQUIRED_NOW" });
    expect(requests.at(-1)).toContain("joi session checkpoint");
    expect(requests.at(-1)).toContain("PAGE_9");
    expect(requests.at(-1)?.length).toBeLessThan(128_000);
    expect(JSON.stringify(snapshot?.archivedMessages)).toContain("PAGE_0");
    expect(JSON.stringify(snapshot?.messages)).toContain("CURRENT_TASK");
    expect(JSON.stringify(snapshot?.messages)).toContain("PAGE_9");
  });
  it("retains the entire latest tool exchange even when it exceeds the soft request bound", () => {
    const call = fauxAssistantMessage([{ type: "toolCall", id: "latest-call", name: "work_read_result", arguments: { resultId: "r" } }], { stopReason: "toolUse" });
    const result: AgentMessage = { role: "toolResult", toolCallId: "latest-call", toolName: "work_read_result", content: [{ type: "text", text: "COMPLETE_LATEST_END".padStart(140_000, "x") }], isError: false, timestamp: 2 };
    const messages = [...history(), call, result];
    const request = boundRequestByChars(messages, 64_000);
    expect(request).toContain(call);
    expect(request).toContain(result);
    expect(JSON.stringify(request)).toContain("MANDATORY_TASK");
  });
  it("pages archived private context through a closure without accepting another session", async () => {
    const source = history();
    const tool = createContextHistoryTool(() => source);
    let offset = 0;
    let body = "";
    do {
      const result = await tool.execute("read", { offset, sessionId: "foreign" });
      const page = JSON.parse((result.content[0] as { text: string }).text) as { body: string; nextOffset: number | null };
      expect(page.body.length).toBeLessThanOrEqual(8000);
      body += page.body;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (offset > 0);
    expect(body).toBe(JSON.stringify(source));
  });
  it("keeps a failed joi summary's old checkpoint and its uncovered source history", async () => {
    const f = fixture("joi-summary-failure");
    const previous = { compactedMessages: 8, count: 1, lastCompactedAt: "2026-10-18T00:00:00Z", summary: "PREVIOUS_CONCLUSION_END" };
    let snapshot: JoiReasoningSessionSnapshot = { workbenchId: "wb", sessionId: "failed", modelRevisionId: "mr", sourceRevisionId: "sr", systemPrompt: "POLICY", updatedAt: "2026-10-19T00:00:00Z", compaction: previous, messages: history() };
    vi.spyOn(f.models, "completeSimple").mockRejectedValue(new Error("summary_failed"));
    f.faux.setResponses([fauxAssistantMessage([fauxText("continued")])]);
    const runtime = new PiReasoningRuntime({ ...f, compaction: { maxMessages: 10, keepRecentMessages: 2 }, thinkingLevel: "high", tools: [], sessionStore: {
      load: async () => snapshot, save: async value => { snapshot = value; },
    } });
    await runtime.startTurn({ workbenchId: "wb", sessionId: "failed", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "POLICY", inputId: "input", turnId: "turn", prompt: "continue" });
    expect(snapshot.compaction).toEqual(previous);
    expect(JSON.stringify(snapshot.messages)).toContain("evidence-0");
    expect(snapshot.messages.length).toBeGreaterThan(50);
  });
  it("compacts Pi at 128K serialized characters independently of the model window toward 64K", async () => {
    const f = fixture("pi-soft-budget");
    f.faux.setResponses([fauxAssistantMessage([fauxText("checkpoint with references and unresolved gaps")])]);
    const manager = createPiContextManager({ ...f, messagesMaxChars: 1_000_000, thinkingLevel: "high" });
    const messages = history();
    const request = await manager.transformContext(messages);
    expect(manager.checkpoint()?.count).toBe(1);
    expect(JSON.stringify(request).length).toBeLessThanOrEqual(64_000);
    expect(JSON.stringify(request)).toContain("MANDATORY_TASK");
    expect(messages).toHaveLength(51);
  });

  it("compacts joi on the same independent budget and preserves the current requirements", async () => {
    const f = fixture("joi-soft-budget");
    f.faux.setResponses([
      fauxAssistantMessage([fauxText("checkpoint with references and unresolved gaps")]),
      context => { expect(JSON.stringify(context)).toContain("REQUIRED_NOW"); return fauxAssistantMessage([fauxText("continued")]); },
    ]);
    let snapshot: JoiReasoningSessionSnapshot = { workbenchId: "wb", sessionId: "session", modelRevisionId: "mr", sourceRevisionId: "sr", systemPrompt: "POLICY", updatedAt: "2026-10-19T00:00:00Z", messages: history() };
    const runtime = new PiReasoningRuntime({ ...f, thinkingLevel: "high", tools: [], sessionStore: {
      load: async () => snapshot, save: async value => { snapshot = value; },
    } });
    await runtime.startTurn({ workbenchId: "wb", sessionId: "session", modelRevisionId: "mr", sourceRevisionId: "sr", sourceId: "s", modelId: "m", systemPrompt: "POLICY", inputId: "input", turnId: "turn", prompt: "continue", requiredContext: "REQUIRED_NOW" });
    expect(snapshot.compaction?.count).toBe(1);
    expect(JSON.stringify(snapshot.messages).length).toBeLessThanOrEqual(64_000);
  });
});
