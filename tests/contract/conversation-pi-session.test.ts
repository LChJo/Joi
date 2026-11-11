/* Faux provider callbacks implement the asynchronous model boundary. */
/* eslint-disable @typescript-eslint/require-await */
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxThinking,fauxToolCall,getCurrentTools } from "@earendil-works/pi-ai";
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

it("CHAT-29 observes actual Pi thinking phases without projecting raw reasoning or signatures",async () => {
  const faux = fauxProvider({ provider: "safe-thinking" }),models = createModels();models.setProvider(faux.provider);
  const updates: ConversationThinkingDto[] = [],events: unknown[] = [];
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {} }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  faux.setResponses([fauxAssistantMessage([{ ...fauxThinking("RAW_REASONING_PRIVATE"),thinkingSignature: "RAW_SIGNATURE_PRIVATE" },fauxText("Public answer")])]);
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-12T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
  try {
    await runtime.runResidentTurn({ instanceId: "thinking",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
      onThinking: async value => { updates.push(value); },onEvent: async value => { events.push(value); },request: { actionId: "turn",workbenchId: "wb",workId: "turn",contextSnapshotId: "s",taskProjection: "Help",conversationId: "chat",subagentsEnabled: false } });
    expect(updates.map(update => update.state)).toEqual(["STARTED","COMPLETED"]);
    expect(updates[1]?.phaseId).toBe(updates[0]?.phaseId);expect(typeof updates[1]?.durationMs).toBe("number");
    expect(updates.every(update => update.summary === undefined)).toBe(true);
    expect(JSON.stringify({ updates,events })).not.toMatch(/RAW_REASONING_PRIVATE|RAW_SIGNATURE_PRIVATE/u);
  } finally { runtime.evictFromMemory("thinking"); }
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
  faux.setResponses(Array.from({ length: 2 },() => context => { requests.push({ names: getCurrentTools(context.messages).map(tool => tool.name),text: JSON.stringify(context.messages) });return fauxAssistantMessage([fauxText("Done")]); }));
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

it("CHAT-21 uses an isolated SDK session, keeps restored history and disables automatic compaction",async () => {
  const faux = fauxProvider({ provider: "conversation-sdk" });const models = createModels();models.setProvider(faux.provider);
  const requests: string[] = [];
  faux.setResponses([context => { requests.push(JSON.stringify(context));return fauxAssistantMessage([fauxText("Current answer")]); }]);
  const agent = new Agent({ initialState: { model: faux.getModel(),systemPrompt: "POLICY",messages: [{ role: "user",content: "RESTORED_FACT",timestamp: 0 }],tools: [] },
    streamFn: (model,context,options) => models.streamSimple(model,context,options) });
  const sdk = await createJoiPiSession(agent,models,"synthetic-workspace");
  try {
    expect(sdk.autoCompactionEnabled).toBe(false);
    await sdk.prompt("Current question",{ expandPromptTemplates: false });
    expect(requests[0]).toContain("RESTORED_FACT");
    expect(requests[0]).toContain("Current question");
    expect(agent.state.messages.some(message => message.role === "assistant")).toBe(true);
  } finally { sdk.dispose(); }
});

it("CHAT-19/20 reuses a restored checkpoint whose prefix contains SDK system projections",async () => {
  const faux = fauxProvider({ provider: "checkpoint-restart" }),models = createModels();models.setProvider(faux.provider);
  const model = { ...faux.getModel(),contextWindow: 2_000_000 };
  const summary = vi.spyOn(models,"completeSimple").mockResolvedValue(fauxAssistantMessage([fauxText("VALID_CHECKPOINT")]));
  const messages: AgentMessage[] = [{ role: "system",content: "POLICY",timestamp: 0 },{ role: "user",content: "ORIGINAL_TASK",timestamp: 1 },
    ...Array.from({ length: 50 },() => fauxAssistantMessage([fauxText("source".padEnd(4000,"中"))]))];
  messages.splice(8,0,{ role: "system",content: "SDK_PROJECTION",timestamp: 2 });
  const manager = createPiContextManager({ model,models,messagesMaxChars: modelRequestBudget(model).messagesMaxChars,thinkingLevel: "off" });
  await manager.transformContext(messages);const checkpoint = manager.checkpoint();if (checkpoint === undefined) throw new Error("Missing checkpoint");
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-11T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: () => Promise.resolve({ promptSection: "",sanitized: {} }) },prompts: { read: () => Promise.resolve(null) },
    resolver: { resolve: () => Promise.resolve({ model,models,thinkingLevel: "off" }) },sources: { selectInitial: turnId => Promise.resolve({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  faux.setResponses([fauxAssistantMessage([fauxText("Continued")])]);
  await runtime.runResidentTurn({ instanceId: "restored-checkpoint",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
    sessionState: { engine: "pi-core",messages,checkpoint,route: JSON.stringify(["s","sr","m","mr"]) },
    request: { actionId: "next",workbenchId: "wb",workId: "next",contextSnapshotId: "snapshot",taskProjection: "Continue",conversationId: "chat",requiredContext: "CURRENT_POLICY" } });
  expect(summary).toHaveBeenCalledTimes(1);runtime.evictFromMemory("restored-checkpoint");
});

it("CHAT-25 rejects a protected oversized tool exchange before a second provider request and retains its source",async () => {
  const faux = fauxProvider({ provider: "conversation-capacity",models: [{ id: "m",contextWindow: 32000,maxTokens: 4096 }] });
  const models = createModels();models.setProvider(faux.provider);let requests = 0;let snapshot: PartnerSessionState | undefined;
  const contexts: unknown[] = [];
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {},workspacePath: "synthetic-workspace" }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },
    tools: { names: ["read"],create: () => [{ name: "read",label: "Read",description: "Read",parameters: Type.Object({}),execute: () => Promise.resolve({ content: [{ type: "text",text: "完整工具结果".repeat(30_000) + "COMPLETE_RESULT_END" }],details: {} }) }] } });
  faux.setResponses([() => { requests++;return fauxAssistantMessage([fauxToolCall("read",{})],{ stopReason: "toolUse" }); },() => { requests++;return fauxAssistantMessage([fauxText("Must not be sent")]); }]);
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-11T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: ["read"],toolPolicyMode: "CUSTOM" });
  await expect(runtime.runResidentTurn({ instanceId: "capacity",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,
    saveSession: async state => { snapshot = state; },onContext: async context => { contexts.push(context); },
    request: { actionId: "parent",workbenchId: "wb",workId: "parent",contextSnapshotId: "snapshot",taskProjection: "Read",conversationId: "chat",subagentsEnabled: false,requiredContext: "MANDATORY_POLICY",workspaceExecution: { accessCeiling: "READ",phase: "READ_RUNNING",generation: 1 } } })).rejects.toMatchObject({ code: "goal_requirements_capacity_exceeded" });
  expect(requests).toBe(1);expect(JSON.stringify(snapshot?.messages).includes("COMPLETE_RESULT_END")).toBe(true);
  expect(contexts).toContainEqual(expect.objectContaining({ state: "CAPACITY" }));expect(JSON.stringify(contexts)).not.toContain("完整工具结果");
  runtime.evictFromMemory("capacity");
});

it("CHAT-22 loads bundled subagent tools offline and delivers child results before the parent concludes",async () => {
  const faux = fauxProvider({ provider: "conversation-children" });const models = createModels();models.setProvider(faux.provider);
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-11T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "CUSTOM" });
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {} }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  const children: ConversationChild[] = [];
  const requests: string[] = [];let toolNames: string[] = [];
  runtime.setSubagents({ start: async input => { const child: ConversationChild = { ...input,childId: "child",status: "COMPLETED",body: "VERIFIED_CHILD_RESULT" };children.push(child);return child; },
    list: async () => children,cancel: async () => undefined,settle: async () => children });
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
