import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { UsageContext, UsageObservation, UsageRecorder } from "../../src/main/application/ports/usage.js";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { PiReasoningRuntime } from "../../src/main/infrastructure/pi/pi-reasoning-runtime.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { vi } from "vitest";
import { trackPiModels } from "../../src/main/infrastructure/pi/pi-usage.js";
import { PiLatency } from "../../src/main/infrastructure/pi/pi-latency.js";

function fixture() {
  const faux = fauxProvider({ provider: "usage-test" });
  faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage("done")));
  const models = createModels(); models.setProvider(faux.provider);
  const contexts: UsageContext[] = []; const observations: UsageObservation[] = [];
  const usage: UsageRecorder = { begin(context) { contexts.push(context); return { id: "id", record(value) { observations.push(value); }, finish: () => undefined }; } };
  const pin = { modelId: "faux", modelRevisionId: "mr", sourceId: "source", sourceRevisionId: "sr", turnId: "t" };
  return { faux, models, contexts, observations, usage, pin };
}

describe("Pi runtime usage attribution", () => {
  it.each(["error","aborted"] as const)("CHAT-40 preserves %s streams and records terminal timing without provider details",async stopReason => {
    const f = fixture(),events: { event: string;fields: Record<string,unknown> }[] = [];
    f.faux.setResponses([fauxAssistantMessage([],{ stopReason,errorMessage: "PRIVATE_PROVIDER_ERROR" })]);
    const models = trackPiModels(f.models,undefined,() => ({ engine: "pi",purpose: "partner",workId: "work" }),
      { emit: (event,fields) => { events.push({ event,fields }); } });
    const stream = models.streamSimple(f.faux.getModel(),{ messages: [] });
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect((await stream.result()).stopReason).toBe(stopReason);
    expect(types).toContain("error");
    const latency = events.filter(event => event.event === "joi.pi.latency").map(event => event.fields);
    for (const stage of ["model_request","model_stream"]) expect(latency).toContainEqual(expect.objectContaining({ stage,state: "completed",status: stopReason === "aborted" ? "canceled" : "failed" }));
    const request = latency.find(event => event.stage === "model_request" && event.state === "started");
    expect(latency).toContainEqual(expect.objectContaining({ stage: "model_stream",requestId: request?.spanId }));
    expect(JSON.stringify(events)).not.toContain("PRIVATE_PROVIDER_ERROR");
  });
  it("CHAT-40 aggregates fast callbacks and preserves measured failures when the diagnostics sink throws",async () => {
    const emit = vi.fn(),latency = new PiLatency({ emit },{ workId: "work" });
    for (let index = 0;index < 100;index++) await latency.callback("live_event","message_update",() => undefined);
    expect(emit).not.toHaveBeenCalled();
    latency.finish("completed");
    expect(emit).toHaveBeenCalledWith("joi.pi.latency",expect.objectContaining({ stage: "live_event",state: "summary",count: 100 }));
    const failure = new Error("PRIVATE_FAILURE");
    const broken = new PiLatency({ emit: () => { throw new Error("PRIVATE_SINK_FAILURE"); } },{});
    await expect(broken.measure("session_save",() => Promise.reject(failure))).rejects.toBe(failure);
  });
  it("refreshes work attribution when reusing a warm partner", async () => {
    const f = fixture();
    const runtime = new PiPartnerEngineRuntime({ usage: f.usage,
      contexts: { loadForExecution: () => Promise.resolve({ promptSection: "", sanitized: {} }) },
      prompts: { read: () => Promise.resolve(null) }, resolver: { resolve: () => Promise.resolve({ model: f.faux.getModel(), models: f.models, thinkingLevel: "off" as const }) },
      sources: { selectInitial: () => Promise.resolve(f.pin) }, tools: { create: () => [], names: [] },
    });
    const revision = createPartnerRevision({ capabilities: [], createdAt: "2026-09-22T00:00:00Z", displayName: "test", kind: "local-pi", partnerId: "partner", partnerRevisionId: "revision", registryRevision: 1, skills: [], tools: [] });
    for (const workId of ["work1", "work2"]) await runtime.runResidentTurn({ instanceId: "instance", revision, restoredMessages: null, knowledgeSection: "", skillEnvironmentKeys: [], skillSection: "", request: { workbenchId: "wb", workId, actionId: workId, contextSnapshotId: "ctx", taskProjection: "task" } });
    expect(f.contexts.map((context) => context.workId)).toEqual(["work1", "work2"]);
    expect(f.observations).toHaveLength(2);
  });
  it("attributes compaction separately while retaining the goal and source", async () => {
    const f = fixture();
    const diagnostics = { emit: vi.fn() };
    const runtime = new PiReasoningRuntime({ diagnostics, usage: f.usage, model: f.faux.getModel(), models: f.models, tools: [], thinkingLevel: "off" as const,
      compaction: { keepRecentMessages: 2, maxMessages: 4, maxSummaryCharacters: 80 },
      sessionStore: { load: () => Promise.resolve(null), save: () => Promise.resolve() },
    });
    for (let index = 0; index < 3; index++) await runtime.startTurn({ ...f.pin, workbenchId: "wb", inputId: `derived${String(index)}`, goalInputId: "goal", sessionId: "session", prompt: "task", systemPrompt: "system" });
    expect(f.contexts.filter((context) => context.purpose === "orchestration")).toHaveLength(3);
    expect(f.contexts.some((context) => context.purpose === "summary")).toBe(true);
    expect(f.contexts.every((context) => context.goalId === "goal" && context.workbenchId === "wb" && context.sourceId === "source")).toBe(true);
    expect(diagnostics.emit).toHaveBeenCalledWith("joi.context.model_completed", expect.objectContaining({ purpose: "summary" }));
    expect(diagnostics.emit).toHaveBeenCalledWith("joi.context.model_completed", expect.objectContaining({ purpose: "orchestration" }));
    const calls = diagnostics.emit.mock.calls as unknown as [string, { durationMs?: unknown }][];
    expect(calls.filter(([name]) => name === "joi.context.model_completed").every(([, fields]) => typeof fields.durationMs === "number" && fields.durationMs >= 0)).toBe(true);
  });
});
