import type { AgentState,AgentMessage } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore,InMemoryModelsStore,type Models,type Message } from "@earendil-works/pi-ai";
import { createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,type AgentSession,type FileEntry,type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PartnerSessionState } from "../../application/ports/partner-instances.js";
import { DomainError } from "../../domain/errors.js";
import { withPiSummaryUsage } from "./pi-summary-usage.js";
import { normalizeImportedHandoff } from "./conversation-session.js";
import { isCheckpointMessage } from "./pi-compaction.js";
import { joiPiSystemPrompt, type JoiPiPromptOptions } from "./joi-pi-system-prompt.js";
import { assertPiRequestCapacity } from "./pi-model-budget.js";
import { WORKBENCH_HISTORY_TOOL } from "./pi-historical-memory-tools.js";

const retainedEvidenceReference = "Reference evidence was read in an earlier execution. Check the source reference again if needed.";

type Snapshot = NonNullable<PartnerSessionState["piSession"]>;

export function restorePiSnapshot(cwd: string,snapshot: Snapshot): SessionManager {
  const invalid = () => new DomainError("conversation_session_invalid","Private session history is invalid.");
  if ((snapshot as { version: unknown }).version !== 1 || snapshot.header === null || typeof snapshot.header !== "object" || !Array.isArray(snapshot.entries)) throw invalid();
  const header = snapshot.header as Record<string,unknown>;
  if (header.type !== "session" || header.version !== 3 || typeof header.id !== "string") throw invalid();
  const known = new Set<string>();
  for (const candidate of snapshot.entries) {
    if (candidate === null || typeof candidate !== "object") throw invalid();
    const entry = candidate as Record<string,unknown>;
    if (typeof entry.id !== "string" || known.has(entry.id) || typeof entry.type !== "string"
      || entry.parentId !== null && (typeof entry.parentId !== "string" || !known.has(entry.parentId))) throw invalid();
    known.add(entry.id);
  }
  if (snapshot.leafId !== null && !known.has(snapshot.leafId)) throw invalid();
  const manager = SessionManager.inMemory(cwd,undefined,structuredClone([snapshot.header,...snapshot.entries]) as FileEntry[]);
  if (snapshot.leafId === null) manager.resetLeaf();else manager.branch(snapshot.leafId);
  return manager;
}

export function snapshotJoiPiSession(session: AgentSession): Snapshot {
  return structuredClone({ version: 1,header: session.sessionManager.getHeader(),entries: session.sessionManager.getEntries(),leafId: session.sessionManager.getLeafId() });
}

/** An unrecorded result is reference data, never a resumable tool instruction. */
export function retainUnknownEffects(manager: SessionManager): void {
  const projection = manager.buildSessionProjection();
  const records = projection.entries.flatMap(entry => entry.messages.map(message => ({ id: entry.sourceEntry.id,message })));
  for (let index = 0;index < records.length;index++) {
    const item = records[index];
    if (item !== undefined) {
      const imported = normalizeImportedHandoff(item.message);
      if (imported !== item.message && imported.role === "user") manager.appendContextEdit(item.id, { content: imported.content });
    }
    if (item !== undefined && isCheckpointMessage(item.message)) {
      manager.appendContextEdit(item.id, null);
      continue;
    }
    if (item?.message.role === "toolResult" && item.message.toolName === WORKBENCH_HISTORY_TOOL
      && !item.message.content.some(block => block.type === "text" && block.text === retainedEvidenceReference)) {
      manager.appendContextEdit(item.id,{ content: [{ type: "text", text: retainedEvidenceReference }] });
    }
    if (item?.message.role !== "assistant") continue;
    if (item.message.content.length === 0 && (item.message.stopReason === "error" || item.message.stopReason === "aborted")) {
      manager.appendContextEdit(item.id, null);
      continue;
    }
    const calls = item.message.content.filter(block => block.type === "toolCall");
    if (calls.length === 0) continue;
    const callIds = new Set(calls.map(call => call.id));
    const after = records.slice(index + 1),boundary = after.findIndex(entry => entry.message.role === "user");
    const results = (boundary < 0 ? after : after.slice(0,boundary)).filter(entry => entry.message.role === "toolResult" && callIds.has(entry.message.toolCallId));
    if (calls.every(call => results.some(entry => entry.message.role === "toolResult" && entry.message.toolCallId === call.id))) continue;
    manager.appendContextEdit(item.id,{ content: [{ type: "text",text: `[joi incomplete tool exchange; effect unknown; inspect current state and do not replay automatically]\n${JSON.stringify({ assistant: item.message,recordedResults: results.map(entry => entry.message) })}` }] });
    for (const entry of results) manager.appendContextEdit(entry.id,null);
  }
}

/** The public factory owns the Agent callbacks, request projection and compaction. */
export async function createJoiPiSession(agent: { state: Pick<AgentState,"model" | "systemPrompt" | "tools" | "thinkingLevel" | "messages"> },models: Models,cwd: string,options: JoiPiPromptOptions & { compactionThresholdPercent?: number;snapshot?: Snapshot;retryAttempts?: number;importedMessages?: unknown[];extensionFactories?: ExtensionFactory[];settingsManager?: SettingsManager;sessionManager?: SessionManager;skillPaths?: readonly string[];loadProjectContext?: boolean } = {}): Promise<AgentSession> {
  const settings = options.settingsManager?.getSettings() ?? { cacheWarming: "off" as const };
  if (options.compactionThresholdPercent !== undefined) {
    const percent = Math.min(95, Math.max(50, options.compactionThresholdPercent));
    const compaction = settings.compaction;
    const key = `${agent.state.model.provider}/${agent.state.model.id}`;
    settings.compaction = { ...compaction, modelOverrides: { ...compaction?.modelOverrides,
      [key]: { ...compaction?.modelOverrides?.[key], reserveTokens: agent.state.model.contextWindow - Math.floor(agent.state.model.contextWindow * percent / 100) } } };
  }
  const settingsManager = SettingsManager.inMemory({ ...settings, ...(options.retryAttempts === undefined ? {} : {
    retry: { enabled: options.retryAttempts > 0,maxRetries: options.retryAttempts } }) });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),modelsStore: new InMemoryModelsStore(),modelsPath: null,refreshOnCreate: false });
  const provider = models.getProvider(agent.state.model.provider);
  if (provider !== undefined) runtime.registerNativeProvider(provider);
  const modelRuntime = new Proxy(runtime,{ get(target,key) {
    if (key === "streamSimple") return (...args: Parameters<Models["streamSimple"]>) => {
      assertPiRequestCapacity(...args);
      return summaryModels.streamSimple(...args);
    };
    if (key === "completeSimple") return (...args: Parameters<Models["completeSimple"]>) => {
      assertPiRequestCapacity(...args);
      return models.completeSimple(...args);
    };
    if (key === "checkAuth" || key === "getAuth") return models[key].bind(models);
    if (key === "hasConfiguredAuth") return () => false;
    const value: unknown = Reflect.get(target,key,target);
    return typeof value === "function" ? value.bind(target) as unknown : value;
  } });
  const sessionManager = options.sessionManager ?? (options.snapshot === undefined ? SessionManager.inMemory(cwd) : restorePiSnapshot(cwd,options.snapshot));
  if (options.snapshot === undefined && options.sessionManager === undefined) for (const message of agent.state.messages) sessionManager.appendMessage(message as Message);
  else {
    if (options.importedMessages !== undefined) {
      const source = sessionManager.buildSessionContext().messages.filter(message => message.role !== "system");
      const imported = (options.importedMessages as AgentMessage[]).filter(message => message.role !== "system");
      if (source.length > imported.length || source.some((message,index) => JSON.stringify(message) !== JSON.stringify(imported[index]))) throw new DomainError("conversation_session_invalid","Imported history does not extend its canonical source.");
      for (const message of imported.slice(source.length)) sessionManager.appendMessage(message as Message);
    }
  }
  retainUnknownEffects(sessionManager);
  const summaryModels = withPiSummaryUsage(models, sessionManager);
  const resourceLoader = new DefaultResourceLoader({ cwd,agentDir: cwd,settingsManager,noExtensions: true,noSkills: true,noThemes: true,noContextFiles: options.loadProjectContext !== true,noPromptTemplates: true,
    additionalSkillPaths: [...(options.skillPaths ?? [])],
    systemPrompt: agent.state.systemPrompt, extensionFactories: [...(options.extensionFactories ?? []), joiPiSystemPrompt(agent.state.tools, options)] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ model: agent.state.model,thinkingLevel: agent.state.thinkingLevel,modelRuntime,cwd,agentDir: cwd,sessionManager,settingsManager,resourceLoader,
    tools: agent.state.tools.map(tool => tool.name),customTools: agent.state.tools.map(tool => ({ ...tool,execute: (id,params,signal,onUpdate) => tool.execute(id,params,signal,onUpdate) })) });
  return session;
}
