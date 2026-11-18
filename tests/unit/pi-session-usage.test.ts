import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { UsageContext, UsageObservation, UsageRecorder } from "../../src/main/application/ports/usage.js";
import { PiSessionUsage } from "../../src/main/infrastructure/pi/pi-session-usage.js";

const tokens = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

it("PI-SESSION-13/14 accounts for canonical slots, import baseline and background use without recharging a Work", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ ...fauxAssistantMessage("Imported"), usage: tokens });
  manager.appendCustomEntry("joi.usage_context", { engine: "pi", purpose: "partner", workId: "first", workbenchId: "wb", sourceId: "source" });
  const assistant = manager.appendMessage({ ...fauxAssistantMessage("Answer"), usage: tokens });
  manager.appendCompaction("Summary", assistant, 100, undefined, false, tokens);
  manager.branchWithSummary(assistant, "Branch summary", undefined, false, tokens);
  manager.appendUsage("extension", "provider", "model", tokens);
  manager.appendCustomEntry("joi.usage_context", { engine: "pi", purpose: "partner", workId: "second", workbenchId: "wb", sourceId: "source" });
  manager.appendMessage({ ...fauxAssistantMessage([], { stopReason: "error" }), usage: tokens });
  manager.appendCustomEntry("joi.usage_idle", {});
  manager.appendUsage("cache_warm", "provider", "model", tokens);
  const records = new Map<string, { context: UsageContext; observation?: UsageObservation; status?: string }>();
  const recorder: UsageRecorder = { begin(context, identity) {
    if (identity === undefined) throw new Error("Missing canonical identity");
    const record = records.get(identity.id) ?? { context };
    records.set(identity.id, record);
    return { id: identity.id, record: value => { record.observation = value; }, finish: status => { record.status = status; } };
  } };
  new PiSessionUsage(recorder).reconcile(manager);
  new PiSessionUsage(recorder).reconcile(manager);
  const values = [...records.values()];
  expect(values).toHaveLength(6);
  expect(values.reduce((total, record) => total + (record.observation?.tokens?.input ?? 0) + (record.observation?.tokens?.output ?? 0), 0)).toBe(96);
  expect(values.filter(record => record.context.workId === "first")).toHaveLength(4);
  expect(values.filter(record => record.context.workId === "second")).toHaveLength(1);
  expect(values.filter(record => record.context.purpose === "summary")).toHaveLength(2);
  expect(values.find(record => record.context.purpose === "cache_warming")).toMatchObject({ context: { sourceId: "source", workbenchId: "wb" } });
  expect(values.find(record => record.context.purpose === "cache_warming")?.context.workId).toBeUndefined();
});
