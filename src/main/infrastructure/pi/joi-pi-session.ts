import type { Agent,AgentMessage } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore,InMemoryModelsStore,type Models,type Message } from "@earendil-works/pi-ai";
import { AgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,type FileEntry } from "@earendil-works/pi-coding-agent";
import type { PartnerSessionState } from "../../application/ports/partner-instances.js";
import { DomainError } from "../../domain/errors.js";

type Snapshot = NonNullable<PartnerSessionState["piSession"]>;

function restoreManager(cwd: string,snapshot: Snapshot): SessionManager {
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
function retainUnknownEffects(manager: SessionManager): void {
  const projection = manager.buildSessionProjection();
  const records = projection.entries.flatMap(entry => entry.messages.map(message => ({ id: entry.sourceEntry.id,message })));
  for (let index = 0;index < records.length;index++) {
    const item = records[index];
    if (item?.message.role !== "assistant") continue;
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

/** Joi owns persistence, route selection, permissions and compaction; the SDK owns session events. */
export async function createJoiPiSession(agent: Agent,models: Models,cwd: string,options: { snapshot?: Snapshot;retryAttempts?: number;importedMessages?: unknown[] } = {}): Promise<AgentSession> {
  const attempts = Math.max(0,Math.min(3,options.retryAttempts ?? 0));
  const stream = agent.streamFunction;
  agent.streamFunction = (model,context,streamOptions) => stream(model,context,{ ...streamOptions,maxRetries: 0 });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false },
    retry: { enabled: attempts > 0,maxRetries: attempts,baseDelayMs: 2000,maxAgentDelayMs: 60_000,provider: { maxRetries: 0 } },cacheWarming: "off" });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),modelsStore: new InMemoryModelsStore(),modelsPath: null,refreshOnCreate: false });
  const provider = models.getProvider(agent.state.model.provider);
  if (provider !== undefined) runtime.registerNativeProvider(provider);
  const modelRuntime = new Proxy(runtime,{ get(target,key) {
    if (key === "checkAuth" || key === "getAuth") return models[key].bind(models);
    if (key === "hasConfiguredAuth") return () => false;
    const value: unknown = Reflect.get(target,key,target);
    return typeof value === "function" ? value.bind(target) as unknown : value;
  } });
  const sessionManager = options.snapshot === undefined ? SessionManager.inMemory(cwd) : restoreManager(cwd,options.snapshot);
  if (options.snapshot === undefined) for (const message of agent.state.messages) sessionManager.appendMessage(message as Message);
  else {
    if (options.importedMessages !== undefined) {
      const source = sessionManager.buildSessionContext().messages.filter(message => message.role !== "system");
      const imported = (options.importedMessages as AgentMessage[]).filter(message => message.role !== "system");
      if (source.length > imported.length || source.some((message,index) => JSON.stringify(message) !== JSON.stringify(imported[index]))) throw new DomainError("conversation_session_invalid","Imported history does not extend its canonical source.");
      for (const message of imported.slice(source.length)) sessionManager.appendMessage(message as Message);
    }
    retainUnknownEffects(sessionManager);
    agent.state.messages = sessionManager.buildSessionContext().messages;
  }
  // No reload or discovery: all resources come from the host's already validated selection.
  const resourceLoader = new DefaultResourceLoader({ cwd,agentDir: cwd,settingsManager,noExtensions: true,noSkills: true,noThemes: true,noContextFiles: true,noPromptTemplates: true });
  const session = new AgentSession({ agent,sessionManager,settingsManager,resourceLoader,modelRuntime,cwd,
    baseToolsOverride: Object.fromEntries(agent.state.tools.map(tool => [tool.name,tool])),initialActiveToolNames: agent.state.tools.map(tool => tool.name),allowedToolNames: agent.state.tools.map(tool => tool.name) });
  session.setAutoCompactionEnabled(false);
  return session;
}
