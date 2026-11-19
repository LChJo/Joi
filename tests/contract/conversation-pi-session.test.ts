/* Faux provider callbacks implement the asynchronous model boundary. */
/* eslint-disable @typescript-eslint/require-await */
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxThinking,fauxToolCall,getCurrentTools,getCurrentSystemPrompt,type Context } from "@earendil-works/pi-ai";
import { createJoiPiSession } from "../../src/main/infrastructure/pi/joi-pi-session.js";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import type { PartnerSessionState } from "../../src/main/application/ports/partner-instances.js";
import type { ConversationChild } from "../../src/main/application/ports/conversation-subagents.js";
import { Type } from "typebox";
import { createPiContextManager } from "../../src/main/infrastructure/pi/pi-context-manager.js";
import { modelRequestBudget } from "../../src/main/infrastructure/pi/pi-model-budget.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConversationThinkingDto } from "../../src/shared/conversations.js";
import { ConversationThinking } from "../../src/main/infrastructure/pi/conversation-thinking.js";
import { WORKSPACE_WRITE_CONTINUATION } from "../../src/main/application/partners/local-write-gate.js";

it.each([
  { summaryState: "FAILED",contextWindow: 96_000,oversized: false },
  { summaryState: "ACCEPTED",contextWindow: 96_000,oversized: false },
  { summaryState: "ACCEPTED",contextWindow: 32_000,oversized: true },
])("CHAT-20/HIST-05 preserves the current repair on WRITE resume ($summaryState summary, $contextWindow tokens)",async ({ summaryState,contextWindow,oversized }) => {
  const faux = fauxProvider({ provider: `current-repair-${summaryState}`,models: [{ id: "m",contextWindow,maxTokens: 4096 }] });
  const models = createModels();models.setProvider(faux.provider);
  const summary = vi.spyOn(models,"completeSimple");
  if (summaryState === "FAILED") summary.mockRejectedValue(new Error("synthetic_summary_failure"));
  else summary.mockResolvedValue(fauxAssistantMessage([fauxText("The previous task was a read-only investigation. Its report is complete.")]));
  const task = "Implement the fix for BUG-4242 and run its regression test.";
  const attachments = "Attachment reference: synthetic-repair-plan";
  const messages: AgentMessage[] = [{ role: "user",content: "Perform a read-only investigation; return a risk report.",timestamp: 0 },
    fauxAssistantMessage([fauxText("The read-only investigation is complete.")]),
    { role: "user",content: [{ type: "text",text: `${task}\n\n${attachments}` }],timestamp: 1 },
    ...Array.from({ length: 16 },() => fauxAssistantMessage([fauxText("Investigation evidence".padEnd(4000,"中"))]))];
  const original = JSON.stringify(messages);
  let receivedTask = false,receivedAttachments = false,receivedContinuation = false,saved: PartnerSessionState | undefined;
  const respond = vi.fn((context: Context) => {
    const text = JSON.stringify(context.messages);
    receivedTask = text.includes(task);receivedAttachments = text.includes(attachments);receivedContinuation = text.includes(WORKSPACE_WRITE_CONTINUATION);
    return fauxAssistantMessage([fauxText(receivedTask ? "Implemented BUG-4242." : "The read-only investigation is complete.")]);
  });
  faux.setResponses([respond]);
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {} }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-17T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
  try {
    const run = runtime.runResidentTurn({ instanceId: "repair-resume",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: messages,
      sessionState: { engine: "pi-core",messages },saveSession: async state => { saved = state; },
      request: { actionId: "repair",workbenchId: "wb",workId: "repair",contextSnapshotId: "snapshot",taskProjection: task,conversationAttachmentContext: attachments,
        conversationId: "chat",subagentsEnabled: false,requiredContext: "Answer the current message directly.",workspaceExecution: { accessCeiling: "WRITE",phase: "WRITE_RUNNING",generation: 2 } } });
    if (oversized) {
      await expect(run).rejects.toMatchObject({ partnerRunFailure: { reasonCode: "context_too_large",sideEffectState: "NONE" } });
      expect(respond).not.toHaveBeenCalled();
    } else {
      await expect(run).resolves.toMatchObject({ output: { body: "Implemented BUG-4242." } });
      expect(receivedContinuation).toBe(false);
      expect(receivedTask).toBe(true);
      expect(receivedAttachments).toBe(true);
    }
    expect(summary).not.toHaveBeenCalled();
    expect(JSON.stringify(messages)).toBe(original);
    expect(saved?.messages.length).toBeGreaterThan(messages.length);
  } finally { runtime.evictFromMemory("repair-resume"); }
});

it("CHAT-04 publishes Pi answer prefixes while the model is still streaming",async () => {
  const faux = fauxProvider({ provider: "conversation-stream",tokenSize: { min: 1,max: 1 },tokensPerSecond: 100 }),models = createModels();models.setProvider(faux.provider);
  const answer = "Streaming words arrive progressively.";
  faux.setResponses([fauxAssistantMessage([fauxText(answer)])]);
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {} }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-13T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
  const parts: { text: string;at: number }[] = [];
  try {
    await runtime.runResidentTurn({ instanceId: "streaming",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
      onEvent: async event => { if (event.type === "message" && event.role === "agent") for (const part of event.parts) if (part.type === "text") parts.push({ text: part.text,at: performance.now() }); },
      request: { actionId: "turn",workbenchId: "wb",workId: "turn",contextSnapshotId: "s",taskProjection: "Help",conversationId: "chat",subagentsEnabled: false } });
    expect(parts.length).toBeGreaterThan(3);
    expect(parts[0]?.text.length).toBeLessThan(answer.length);
    expect(performance.now() - (parts[0]?.at ?? performance.now())).toBeGreaterThan(80);
  } finally { runtime.evictFromMemory("streaming"); }
});

it("REL-07 restores canonical entries and an omission edit without losing the raw failure or its stable identity",async () => {
  const faux = fauxProvider({ provider: "canonical-restore" }),models = createModels();models.setProvider(faux.provider);
  const makeAgent = () => new Agent({ initialState: { model: faux.getModel(),systemPrompt: "POLICY",tools: [] },streamFn: (model,context,options) => models.streamSimple(model,context,options) });
  faux.setResponses([fauxAssistantMessage([fauxText("RAW_FAILED_ATTEMPT")],{ stopReason: "error",errorMessage: "synthetic_failure" })]);
  const first = await createJoiPiSession(makeAgent(),models,"synthetic-workspace");
  await first.prompt("ORIGINAL_TASK",{ expandPromptTemplates: false });
  const failed = first.sessionManager.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant");
  if (failed === undefined) throw new Error("Missing failed entry");
  first.sessionManager.appendContextEdit(failed.id,null);
  const snapshot = { version: 1 as const,header: first.sessionManager.getHeader(),entries: first.sessionManager.getEntries(),leafId: first.sessionManager.getLeafId() };
  first.dispose();
  const restoredAgent = makeAgent();
  const restored = await createJoiPiSession(restoredAgent,models,"synthetic-workspace",{ snapshot });
  try {
    expect(restored.sessionManager.getEntries()).toEqual(snapshot.entries);
    expect(restored.sessionManager.getLeafId()).toBe(snapshot.leafId);
    expect(restored.agent.state.messages).toEqual(restored.sessionManager.buildSessionContext().messages);
    expect(JSON.stringify(restored.agent.state.messages)).toContain("ORIGINAL_TASK");
    expect(JSON.stringify(restored.agent.state.messages)).not.toContain("RAW_FAILED_ATTEMPT");
    expect(JSON.stringify(restored.sessionManager.getEntry(failed.id))).toContain("RAW_FAILED_ATTEMPT");
  } finally { restored.dispose(); }
});

it("REL-10 imports an unrecorded tool effect as reference history without replaying the call",async () => {
  const faux = fauxProvider({ provider: "unknown-effect" }),models = createModels();models.setProvider(faux.provider);
  const call = fauxAssistantMessage([fauxToolCall("write",{},{ id: "unrecorded-call" })],{ stopReason: "toolUse" });
  const entries = [{ type: "message",id: "user",parentId: null,timestamp: "2026-11-13T00:00:00Z",message: { role: "user",content: "Original task",timestamp: 0 } },
    { type: "message",id: "intent",parentId: "user",timestamp: "2026-11-13T00:00:00Z",message: call }];
  const tool = vi.fn(async () => ({ content: [{ type: "text" as const,text: "Must not execute" }],details: {} }));
  const agent = new Agent({ initialState: { model: faux.getModel(),tools: [{ name: "write",label: "Write",description: "Synthetic",parameters: Type.Object({}),execute: tool }] },streamFn: (model,context,options) => models.streamSimple(model,context,options) });
  const session = await createJoiPiSession(agent,models,"synthetic-workspace",{ snapshot: { version: 1,header: { type: "session",id: "private",version: 3,cwd: "synthetic",timestamp: "2026-11-13T00:00:00Z" },entries,leafId: "intent" } });
  try {
    expect(JSON.stringify(session.agent.state.messages)).toContain("effect unknown");
    expect(session.agent.state.messages.some(message => message.role === "assistant" && message.content.some(block => block.type === "toolCall"))).toBe(false);
    expect(session.sessionManager.getEntries().slice(0,2)).toEqual(entries);
    expect(session.agent.state.messages).toEqual(session.sessionManager.buildSessionContext().messages);
    faux.setResponses([fauxAssistantMessage([fauxText("Inspect current state before continuing")])]);
    await session.prompt("What happened?",{ expandPromptTemplates: false });expect(tool).not.toHaveBeenCalled();
  } finally { session.dispose(); }
});

it.each(["readable","empty","whitespace","long"] as const)("CHAT-09/29 projects only the lifecycle of %s private Pi thinking",async scenario => {
  const faux = fauxProvider({ provider: "safe-thinking" }),models = createModels();models.setProvider(faux.provider);
  const updates: ConversationThinkingDto[] = [],events: unknown[] = [];
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {} }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  const content = scenario === "empty" ? "" : scenario === "whitespace" ? " \n\t " : scenario === "long" ? "思".repeat(2200) : "已定位事件投影。 token=synthetic-secret";
  faux.setResponses([fauxAssistantMessage([{ ...fauxThinking(content),thinkingSignature: "RAW_SIGNATURE_PRIVATE" },fauxText("Public answer")])]);
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-12T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
  try {
    await runtime.runResidentTurn({ instanceId: "thinking",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
      onThinking: async value => { updates.push(value); },onEvent: async value => { events.push(value); },request: { actionId: "turn",workbenchId: "wb",workId: "turn",contextSnapshotId: "s",taskProjection: "Help",conversationId: "chat",subagentsEnabled: false } });
    expect(updates.map(update => update.state)).toEqual(["STARTED","COMPLETED"]);
    expect(updates[1]?.phaseId).toBe(updates[0]?.phaseId);expect(typeof updates[1]?.durationMs).toBe("number");
    expect(updates.every(update => update.summary === undefined)).toBe(true);
    expect(JSON.stringify({ updates,events })).not.toMatch(/synthetic-secret|RAW_SIGNATURE_PRIVATE/u);
    expect(JSON.stringify(events)).not.toContain("已定位事件投影");
  } finally { runtime.evictFromMemory("thinking"); }
});

it("CHAT-29 omits redacted Pi thinking payloads and signatures",async () => {
  const updates: ConversationThinkingDto[] = [],thinking = new ConversationThinking(async value => { updates.push(value); },"turn");
  const message = fauxAssistantMessage([{ ...fauxThinking("REDACTED_PAYLOAD_PRIVATE"),redacted: true,thinkingSignature: "SIGNATURE_PRIVATE" }]);
  await thinking.pi({ type: "message_start",message });
  await thinking.pi({ type: "message_update",message,assistantMessageEvent: { type: "thinking_start",contentIndex: 0,partial: message } });
  await thinking.pi({ type: "message_update",message,assistantMessageEvent: { type: "thinking_end",contentIndex: 0,content: "REDACTED_PAYLOAD_PRIVATE",partial: message } });
  expect(updates.map(value => value.state)).toEqual(["STARTED","COMPLETED"]);
  expect(updates.at(-1)?.summary).toBeUndefined();expect(JSON.stringify(updates)).not.toMatch(/REDACTED_PAYLOAD_PRIVATE|SIGNATURE_PRIVATE/u);
});

it.each(["ALL","CUSTOM","READ","CHILD","MODEL_SWITCH"] as const)("CHAT-28 projects enabled coding guidance into the actual %s SDK request after restore",async mode => {
  const faux = fauxProvider({ provider: `coding-guidance-${mode}` }),models = createModels();models.setProvider(faux.provider);
  const names = ["read","grep","find","ls","bash","write"];
  let modelRevisionId = "mr";
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {},workspacePath: "synthetic-workspace" }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId,sourceId: "s",sourceRevisionId: "sr" }) },
    tools: { names,create: (_cwd,selected) => selected.map(name => ({ name,label: name,description: name,parameters: Type.Object({}),execute: async () => ({ content: [{ type: "text",text: "Synthetic" }],details: {} }) })) } });
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-12T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: mode === "CUSTOM" ? ["read","bash"] : [],toolPolicyMode: mode === "CUSTOM" ? "CUSTOM" : "ALL" });
  const requests: { names: string[];text: string }[] = [];
  faux.setResponses(Array.from({ length: 2 },() => context => { requests.push({ names: getCurrentTools(context.messages).map(tool => tool.name),text: getCurrentSystemPrompt(context.messages) });return fauxAssistantMessage([fauxText("Done")]); }));
  let saved: PartnerSessionState | undefined;
  const input = { instanceId: `guidance-${mode}`,knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
    saveSession: async (state: PartnerSessionState) => { saved = state; },request: { actionId: "first",workbenchId: "wb",workId: "first",contextSnapshotId: "snapshot",taskProjection: "Inspect",conversationId: "chat",subagentsEnabled: false,requiredContext: "CURRENT_POLICY",
      ...(mode === "CHILD" ? { subagentChild: true } : {}),
      ...(mode === "READ" ? { workspaceExecution: { accessCeiling: "READ" as const,phase: "READ_RUNNING" as const,generation: 1 } } : {}) } };
  try {
    await runtime.runResidentTurn(input);runtime.evictFromMemory(input.instanceId);
    if (mode === "MODEL_SWITCH") modelRevisionId = "next-model-revision";
    await runtime.runResidentTurn({ ...input,...(saved === undefined ? {} : { sessionState: saved }),...(mode === "MODEL_SWITCH" ? { revision: { ...revision,partnerRevisionId: "r2",tools: ["read"],toolPolicyMode: "CUSTOM" as const } } : {}),request: { ...input.request,actionId: "second",workId: "second" } });
    expect(requests).toHaveLength(2);
    for (const [index,request] of requests.entries()) {
      const narrowed = mode === "MODEL_SWITCH" && index === 1;
      expect(request.text).toContain("Use read to examine files instead of cat or sed.");
      expect(request.text.includes("Use grep (ripgrep) for content searches")).toBe(mode !== "CUSTOM" && !narrowed);
      expect(request.text.includes("Use find (fd) for file-name and glob searches")).toBe(mode !== "CUSTOM" && !narrowed);
      expect(request.text.includes("Use ls for directory listings")).toBe(mode !== "CUSTOM" && !narrowed);
      expect(request.text.includes("Use bash for builds, tests, scripts")).toBe(mode !== "READ" && !narrowed);
      expect(request.names.filter(name => names.includes(name))).toEqual(narrowed ? ["read"] : mode === "CUSTOM" ? ["read","bash"] : mode === "READ" ? ["read","grep","find","ls"] : names);
      expect(request.text).not.toContain("inspect PI_* environment variables");
    }
  } finally { runtime.evictFromMemory(input.instanceId); }
});

it("CHAT-21 uses an isolated SDK session, keeps restored history and enables SDK automatic compaction",async () => {
  const faux = fauxProvider({ provider: "conversation-sdk" });const models = createModels();models.setProvider(faux.provider);
  const requests: string[] = [];
  faux.setResponses([context => { requests.push(JSON.stringify(context));return fauxAssistantMessage([fauxText("Current answer")]); }]);
  const agent = new Agent({ initialState: { model: faux.getModel(),systemPrompt: "POLICY",messages: [{ role: "user",content: "RESTORED_FACT",timestamp: 0 }],tools: [] },
    streamFn: (model,context,options) => models.streamSimple(model,context,options) });
  const sdk = await createJoiPiSession(agent,models,"synthetic-workspace");
  try {
    expect(sdk.autoCompactionEnabled).toBe(true);
    await sdk.prompt("Current question",{ expandPromptTemplates: false });
    expect(requests[0]).toContain("RESTORED_FACT");
    expect(requests[0]).toContain("Current question");
    expect(sdk.agent.state.messages.some(message => message.role === "assistant")).toBe(true);
  } finally { sdk.dispose(); }
});

it("CHAT-19/20 reuses a restored checkpoint whose prefix contains SDK system projections",async () => {
  const faux = fauxProvider({ provider: "checkpoint-restart" }),models = createModels();models.setProvider(faux.provider);
  const model = { ...faux.getModel(),contextWindow: 2_000_000 };
  const summary = vi.spyOn(models,"completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("VALID_CHECKPOINT")]));
  const messages: AgentMessage[] = [{ role: "system",content: "POLICY",timestamp: 0 },{ role: "user",content: "ORIGINAL_TASK",timestamp: 1 },
    ...Array.from({ length: 50 },() => fauxAssistantMessage([fauxText("source".padEnd(4000,"中"))]))];
  messages.splice(8,0,{ role: "system",content: "SDK_PROJECTION",timestamp: 2 });
  const manager = createPiContextManager({ model,models,messagesMaxChars: modelRequestBudget(model).messagesMaxChars,thinkingLevel: "off",routeRevision: JSON.stringify(["s","sr","m","mr"]) });
  for (let index = 0; index < 6; index += 1) {
    await manager.transformContext(messages);
    await new Promise<void>(resolve => { setImmediate(resolve); }); manager.collect(messages);
  }
  await manager.close(messages);
  const checkpoint = manager.checkpoint();if (checkpoint === undefined) throw new Error("Missing checkpoint");
  const summaryCallsBeforeRestore = summary.mock.calls.length;
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-11T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: () => Promise.resolve({ promptSection: "",sanitized: {} }) },prompts: { read: () => Promise.resolve(null) },
    resolver: { resolve: () => Promise.resolve({ model,models,thinkingLevel: "off" }) },sources: { selectInitial: turnId => Promise.resolve({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  faux.setResponses([fauxAssistantMessage([fauxText("Continued")])]);
  await runtime.runResidentTurn({ instanceId: "restored-checkpoint",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
    sessionState: { engine: "pi-core",messages,checkpoint,route: JSON.stringify(["s","sr","m","mr"]) },
    request: { actionId: "next",workbenchId: "wb",workId: "next",contextSnapshotId: "snapshot",taskProjection: "Continue",conversationId: "chat",requiredContext: "CURRENT_POLICY" } });
  expect(summary).toHaveBeenCalledTimes(summaryCallsBeforeRestore);runtime.evictFromMemory("restored-checkpoint");
});

it("CHAT-22 loads bundled subagent tools offline and delivers child results before the parent concludes",async () => {
  const faux = fauxProvider({ provider: "conversation-children" });const models = createModels();models.setProvider(faux.provider);
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-11T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {} }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  const children: ConversationChild[] = [];
  const requests: string[] = [];let toolNames: string[] = [];
  runtime.setSubagents({ start: async input => { const child: ConversationChild = { ...input,childId: "child",status: "QUEUED" };children.push(child);return child; },
    list: async () => children,cancel: async () => undefined,settle: async () => {
      for (const child of children) { child.status = "COMPLETED";child.body = "VERIFIED_CHILD_RESULT"; }return children;
    } });
  faux.setResponses([context => {
    toolNames = getCurrentTools(context.messages).map(tool => tool.name);requests.push(JSON.stringify(context.messages));
    return fauxAssistantMessage([fauxToolCall("subagent",{ task: "Inspect" })],{ stopReason: "toolUse" });
  },context => { requests.push(JSON.stringify(context.messages));return fauxAssistantMessage([fauxText("Parent conclusion")]); }]);
  const result = await runtime.runResidentTurn({ instanceId: "parent-sdk",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
    request: { actionId: "parent",workbenchId: "wb",workId: "parent",contextSnapshotId: "snapshot",taskProjection: "Help",conversationId: "chat",workspaceExecution: { accessCeiling: "READ",phase: "READ_RUNNING",generation: 1 } } });
  expect(toolNames).toContain("subagent");expect(requests[1]).toContain("VERIFIED_CHILD_RESULT");
  expect(result.output.body).toContain("Parent conclusion");expect(children).toHaveLength(1);
  expect(children[0]?.sourcePin).toMatchObject({ sourceId: "s",modelRevisionId: "mr" });
  runtime.evictFromMemory("parent-sdk");
});

it("CHAT-19/21 resumes the full private Pi transcript in a cold instance after a failed turn",async () => {
  const faux = fauxProvider({ provider: "conversation-restart" });const models = createModels();models.setProvider(faux.provider);
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-11T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
  let snapshot: PartnerSessionState | undefined;
  const make = () => new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {} }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  const first = make();
  faux.setResponses([fauxAssistantMessage([fauxText("PARTIAL_FACT")],{ stopReason: "error",errorMessage: "synthetic_failure" })]);
  const input = { instanceId: "first",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
    saveSession: async (state: PartnerSessionState) => { snapshot = structuredClone(state); },
    request: { actionId: "a",workbenchId: "wb",workId: "w",contextSnapshotId: "snapshot",taskProjection: "ORIGINAL_USER_FACT",conversationId: "chat",requiredContext: "PERSONA" } };
  await expect(first.runResidentTurn(input)).rejects.toHaveProperty("code");
  expect(JSON.stringify(snapshot?.messages)).toContain("PARTIAL_FACT");first.evictFromMemory("first");
  const second = make();
  faux.setResponses([context => {
    const history = JSON.stringify(context.messages);expect(history).toContain("ORIGINAL_USER_FACT");expect(history).toContain("PARTIAL_FACT");
    return fauxAssistantMessage([fauxText("Continued")]);
  }]);
  await expect(second.runResidentTurn({ ...input,instanceId: "second",...(snapshot === undefined ? {} : { sessionState: snapshot }),request: { ...input.request,actionId: "b",taskProjection: "Continue without repeating side effects" } })).resolves.toMatchObject({ output: { body: "Continued" } });
  second.evictFromMemory("second");
});
