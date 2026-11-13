/* Synthetic providers implement asynchronous execution ports. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime";
import { createPartnerRevision } from "../../src/main/domain/partners/partner";
import type { PartnerSessionState } from "../../src/main/application/ports/partner-instances";
import type { ConversationContextDto } from "../../src/shared/conversations";
import { NativeConversationJournal } from "../../src/main/infrastructure/pi/native-conversation-journal";

function fixture(options: { runIdleTimeoutMillis?: number } = {}) {
  const faux = fauxProvider({ provider: "reliability" }),models = createModels();models.setProvider(faux.provider);
  const tool = vi.fn(async () => ({ content: [{ type: "text" as const,text: "DURABLE_TOOL_RESULT" }],details: {} }));
  const runtime = new PiPartnerEngineRuntime({ ...options,contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {},workspacePath: "synthetic-workspace" }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },
    tools: { names: ["write"],create: () => [{ name: "write",label: "Write",description: "Synthetic effect",parameters: Type.Object({}),execute: tool }] } });
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-12T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: ["write"],toolPolicyMode: "CUSTOM" });
  const input = { instanceId: "reliable",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
    request: { actionId: "turn",workbenchId: "wb",workId: "turn",contextSnapshotId: "snapshot",taskProjection: "Complete the task",conversationId: "chat",subagentsEnabled: false } };
  return { faux,models,runtime,tool,input };
}

it("REL-04/16 retries two model timeouts within the same session, settles once and never replays the completed tool",async () => {
  vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout","Date"] });
  const { faux,models,runtime,tool,input } = fixture();let snapshot: PartnerSessionState | undefined;
  const stream = vi.spyOn(models,"streamSimple");
  const contexts: ConversationContextDto[] = [];let requests = 0,settled = false;
  const counted = (message: ReturnType<typeof fauxAssistantMessage>) => () => { requests++;return message; };
  faux.setResponses([
    counted(fauxAssistantMessage([fauxToolCall("write",{},{ id: "stable-call" })],{ stopReason: "toolUse" })),
    counted(fauxAssistantMessage([fauxText("PRIVATE_FAILED_ONE")],{ stopReason: "error",errorMessage: "request timeout" })),
    counted(fauxAssistantMessage([],{ stopReason: "error",errorMessage: "request timeout" })),
    context => { requests++;expect(JSON.stringify(context)).toContain("DURABLE_TOOL_RESULT");expect(JSON.stringify(context)).not.toContain("PRIVATE_FAILED_ONE");return fauxAssistantMessage([fauxText("Recovered answer")]); },
  ]);
  try {
    const run = runtime.runResidentTurn({ ...input,onContext: async value => { contexts.push(value); },saveSession: async value => { snapshot = structuredClone(value); } }).finally(() => { settled = true; });
    void run.catch(() => undefined);
    await vi.waitFor(() => expect(contexts.some(value => value.recovery?.attempt === 1)).toBe(true));
    expect(settled).toBe(false);expect(tool).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(contexts.some(value => value.recovery?.attempt === 2)).toBe(true));
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(run).resolves.toMatchObject({ status: "COMPLETED",output: { body: "Recovered answer" } });
    expect(tool).toHaveBeenCalledTimes(1);expect(requests).toBe(4);
    expect(stream.mock.calls.every(call => call[2]?.maxRetries === 0)).toBe(true);
    expect(snapshot?.piSession?.entries.filter(entry => (entry as { type: string }).type === "context_edit")).toHaveLength(2);
    expect(JSON.stringify(snapshot?.piSession)).toContain("PRIVATE_FAILED_ONE");
    expect(JSON.stringify(snapshot?.messages)).not.toContain("PRIVATE_FAILED_ONE");
    expect(JSON.stringify(contexts)).not.toMatch(/PRIVATE_FAILED_ONE|request timeout|DURABLE_TOOL_RESULT/u);
  } finally { runtime.evictFromMemory(input.instanceId);vi.useRealTimers(); }
});

it("REL-05 exhausts one three-retry budget and retains the final safe reason",async () => {
  vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout","Date"] });
  const { faux,runtime,input } = fixture();let requests = 0;let snapshot: PartnerSessionState | undefined;
  const contexts: ConversationContextDto[] = [];
  faux.setResponses(Array.from({ length: 4 },() => () => { requests++;return fauxAssistantMessage([],{ stopReason: "error",errorMessage: "request timeout PRIVATE_FAILURE" }); }));
  try {
    const run = runtime.runResidentTurn({ ...input,onContext: async value => { contexts.push(value); },saveSession: async value => { snapshot = structuredClone(value); } });
    const failure = expect(run).rejects.toMatchObject({ code: "timeout" });
    await vi.waitFor(() => expect(contexts.some(value => value.recovery?.attempt === 1)).toBe(true));
    await vi.advanceTimersByTimeAsync(14_000);await failure;
    expect(requests).toBe(4);expect(snapshot?.modelRetry?.attempts).toBe(3);
    expect(contexts.at(-1)?.recovery?.state).toBe("EXHAUSTED");
  } finally { runtime.evictFromMemory(input.instanceId);vi.useRealTimers(); }
});

it("REL-09 keeps retry backoff separate from the model stream idle deadline",async () => {
  vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout","Date"] });
  const { faux,runtime,input } = fixture({ runIdleTimeoutMillis: 100 });
  const contexts: ConversationContextDto[] = [];
  faux.setResponses([fauxAssistantMessage([],{ stopReason: "error",errorMessage: "request timeout" }),fauxAssistantMessage([fauxText("Recovered")])]);
  try {
    const run = runtime.runResidentTurn({ ...input,onContext: async value => { contexts.push(value); } });void run.catch(() => undefined);
    await vi.waitFor(() => expect(contexts.some(value => value.recovery?.state === "RETRYING")).toBe(true));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(run).resolves.toMatchObject({ status: "COMPLETED",output: { body: "Recovered" } });
  } finally { runtime.evictFromMemory(input.instanceId);vi.useRealTimers(); }
});

it("REL-09 cancels SDK retry backoff without starting another model attempt",async () => {
  vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout","Date"] });
  const { faux,runtime,input } = fixture(),controller = new AbortController();let requests = 0;
  const contexts: ConversationContextDto[] = [];
  faux.setResponses([() => { requests++;return fauxAssistantMessage([],{ stopReason: "error",errorMessage: "request timeout" }); },() => { requests++;return fauxAssistantMessage([fauxText("Must not run")]); }]);
  try {
    const run = runtime.runResidentTurn({ ...input,signal: controller.signal,onContext: async value => { contexts.push(value); } });
    const failure = expect(run).rejects.toHaveProperty("code");
    await vi.waitFor(() => expect(contexts.some(value => value.recovery?.state === "RETRYING")).toBe(true));
    controller.abort();await failure;
    await vi.advanceTimersByTimeAsync(60_000);expect(requests).toBe(1);
    expect(contexts.at(-1)?.recovery?.state).toBe("CANCELED");
  } finally { runtime.evictFromMemory(input.instanceId);vi.useRealTimers(); }
});

it("REL-10 fails safely when a completed tool result cannot be saved and never requests another model response",async () => {
  const { faux,runtime,tool,input } = fixture();let requests = 0;
  faux.setResponses([() => { requests++;return fauxAssistantMessage([fauxToolCall("write",{},{ id: "stable-effect" })],{ stopReason: "toolUse" }); },() => { requests++;return fauxAssistantMessage([fauxText("Must not complete")]); }]);
  try {
    const run = runtime.runResidentTurn({ ...input,saveSession: async state => {
      if (state.messages.some(message => (message as { role?: string }).role === "toolResult")) throw new Error("PRIVATE_DISK_FAILURE");
    } });
    await expect(run).rejects.toMatchObject({ code: "conversation_persistence_failed",partnerRunFailure: { phase: "RECOVERY",sideEffectState: "UNKNOWN",retryable: false } });
    expect(tool).toHaveBeenCalledTimes(1);expect(requests).toBe(1);
  } finally { runtime.evictFromMemory(input.instanceId); }
});

it("REL-08 preserves canonical IDs when importing history appended by a native engine",async () => {
  const { faux,runtime,input } = fixture();let saved: PartnerSessionState | undefined;
  const saveSession = async (state: PartnerSessionState) => { saved = structuredClone(state); };
  faux.setResponses([fauxAssistantMessage([fauxText("First answer")])]);
  try {
    await runtime.runResidentTurn({ ...input,saveSession });runtime.evictFromMemory(input.instanceId);
    if (saved?.piSession === undefined) throw new Error("Missing canonical source");
    const original = saved.piSession.entries;
    let native: PartnerSessionState = saved;
    const journal = new NativeConversationJournal("codex",{ ...input.request,taskProjection: "NATIVE_ENGINE_FACT" },{ knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],sessionState: saved,saveSession: async value => { native = structuredClone(value); } });
    await journal.assistant([{ type: "text",text: "Native answer" }]);
    expect(native.piSession?.entries).toEqual(original);
    faux.setResponses([context => { expect(JSON.stringify(context)).toContain("NATIVE_ENGINE_FACT");return fauxAssistantMessage([fauxText("Continued")]); }]);
    await runtime.runResidentTurn({ ...input,saveSession,sessionState: native,request: { ...input.request,actionId: "next",workId: "next",taskProjection: "Continue" } });
    expect(saved.piSession.entries.slice(0,original.length)).toEqual(original);
  } finally { runtime.evictFromMemory(input.instanceId); }
});

it("REL-06 does not retry an authentication failure whose provider text also mentions a timeout",async () => {
  const { faux,runtime,input } = fixture();let requests = 0;
  faux.setResponses([() => { requests++;return fauxAssistantMessage([],{ stopReason: "error",errorMessage: "HTTP 401 unauthorized request timeout PRIVATE_CREDENTIAL" }); }]);
  try {
    await expect(runtime.runResidentTurn(input)).rejects.toMatchObject({ code: "http_401",partnerRunFailure: { retryable: false } });
    expect(requests).toBe(1);
  } finally { runtime.evictFromMemory(input.instanceId); }
});

it("REL-09 isolates an unresponsive provider, bounds stop and retires its late events",async () => {
  vi.useFakeTimers({ toFake: ["setTimeout","clearTimeout","Date"] });
  const { faux,runtime,input,tool } = fixture(),controller = new AbortController();
  let release: ((message: ReturnType<typeof fauxAssistantMessage>) => void) | undefined;const saves = vi.fn(async () => undefined);
  faux.setResponses([async () => new Promise<ReturnType<typeof fauxAssistantMessage>>(resolve => { release = resolve; }),fauxAssistantMessage([fauxText("Independent answer")])]);
  try {
    const stalled = runtime.runResidentTurn({ ...input,signal: controller.signal,saveSession: saves });
    const stopped = expect(stalled).rejects.toMatchObject({ code: "conversation_cleanup_timed_out" });
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(runtime.runResidentTurn({ ...input,instanceId: "independent",request: { ...input.request,conversationId: "other",workId: "other",actionId: "other" } })).resolves.toMatchObject({ output: { body: "Independent answer" } });
    controller.abort();await vi.advanceTimersByTimeAsync(5000);await stopped;
    const count = saves.mock.calls.length;release?.(fauxAssistantMessage([fauxToolCall("write",{},{ id: "late-effect" })],{ stopReason: "toolUse" }));
    await vi.advanceTimersByTimeAsync(0);expect(saves).toHaveBeenCalledTimes(count);expect(tool).not.toHaveBeenCalled();
  } finally { runtime.evictFromMemory(input.instanceId);runtime.evictFromMemory("independent");vi.useRealTimers(); }
});
