import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import { JsonLineRuntimeDiagnostics } from "../../src/main/infrastructure/runtime/json-line-runtime-diagnostics.js";
import { TestClock } from "../support/runtime-fixture.js";

it("CHAT-40 separates model, tool and awaited callback latency without recording private data", async () => {
  let elapsed = 0;
  const clock = vi.spyOn(performance,"now").mockImplementation(() => elapsed);
  const lines: string[] = [];
  const diagnostics = new JsonLineRuntimeDiagnostics({ clock: new TestClock(),write: line => { lines.push(line); } });
  const faux = fauxProvider({ provider: "latency-test" }),models = createModels();models.setProvider(faux.provider);
  faux.setResponses([
    () => { elapsed += 50;return fauxAssistantMessage([fauxToolCall("read",{ path: "C:/PRIVATE_PATH/input.txt" },{ id: "PRIVATE_CALL_ID" })]); },
    () => { elapsed += 50;return fauxAssistantMessage([fauxText("PRIVATE_REPLY")]); },
  ]);
  const runtime = new PiPartnerEngineRuntime({ diagnostics,
    contexts: { loadForExecution: () => Promise.resolve({ promptSection: "",sanitized: {},workspacePath: "synthetic-workspace" }) },
    prompts: { read: () => Promise.resolve(null) },
    resolver: { resolve: () => Promise.resolve({ model: faux.getModel(),models,thinkingLevel: "off" }) },
    sources: { selectInitial: () => Promise.resolve({ turnId: "t",modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },
    tools: { names: ["read"],create: () => [{ name: "read",label: "read",description: "read",parameters: Type.Object({ path: Type.String() }),
      execute: () => { elapsed += 7;return Promise.resolve({ content: [{ type: "text",text: "PRIVATE_RESULT" }],details: {} }); } }] },
  });
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-12T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: ["read"],toolPolicyMode: "CUSTOM" });
  try {
    await runtime.runResidentTurn({ instanceId: "latency",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
      saveSession: () => { elapsed += 25;return Promise.resolve(); },
      onEvent: () => { elapsed += 120;return Promise.resolve(); },
      request: { actionId: "turn",workbenchId: "wb",workId: "turn",contextSnapshotId: "s",taskProjection: "PRIVATE_PROMPT",conversationId: "chat",subagentsEnabled: false,
        workspaceExecution: { accessCeiling: "READ",phase: "READ_RUNNING",generation: 1 } } });
    const events = lines.map(line => JSON.parse(line) as Record<string,unknown>).filter(event => event.event === "joi.pi.latency");
    const completed = events.filter(event => event.state === "completed");
    expect(completed).toContainEqual(expect.objectContaining({ stage: "model_request",workId: "turn",durationMs: expect.any(Number) as unknown,spanId: expect.any(String) as unknown }));
    expect(events).toContainEqual(expect.objectContaining({ stage: "model_request",state: "first_event" }));
    expect(events).toContainEqual(expect.objectContaining({ stage: "model_request",state: "first_delta" }));
    expect(completed).toContainEqual(expect.objectContaining({ stage: "model_stream" }));
    expect(completed).toContainEqual(expect.objectContaining({ stage: "tool",toolName: "read",sdkDurationMs: 7 }));
    expect(completed).toContainEqual(expect.objectContaining({ stage: "session_save",durationMs: 25 }));
    expect(completed).toContainEqual(expect.objectContaining({ stage: "context_prepare" }));
    expect(events).toContainEqual(expect.objectContaining({ stage: "live_event",state: "slow",durationMs: 120 }));
    expect(events).toContainEqual(expect.objectContaining({ stage: "live_event",state: "summary",count: expect.any(Number) as unknown,maxMs: 120 }));
    expect(completed).toContainEqual(expect.objectContaining({ stage: "turn" }));
    expect(events.every(event => event.durationMs === undefined || typeof event.durationMs === "number" && event.durationMs >= 0)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_|C:\\|C:\//u);
  } finally { runtime.evictFromMemory("latency");clock.mockRestore(); }
});
