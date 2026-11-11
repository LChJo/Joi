import type { Agent } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore,InMemoryModelsStore,type Models,type Message } from "@earendil-works/pi-ai";
import { AgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager } from "@earendil-works/pi-coding-agent";

/** Joi owns persistence, route selection, permissions and compaction; the SDK owns session events. */
export async function createJoiPiSession(agent: Agent,models: Models,cwd: string): Promise<AgentSession> {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false },retry: { enabled: false },cacheWarming: "off" });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),modelsStore: new InMemoryModelsStore(),modelsPath: null,refreshOnCreate: false });
  const provider = models.getProvider(agent.state.model.provider);
  if (provider !== undefined) runtime.registerNativeProvider(provider);
  const modelRuntime = new Proxy(runtime,{ get(target,key) {
    if (key === "checkAuth" || key === "getAuth") return models[key].bind(models);
    if (key === "hasConfiguredAuth") return () => false;
    const value: unknown = Reflect.get(target,key,target);
    return typeof value === "function" ? value.bind(target) as unknown : value;
  } });
  const sessionManager = SessionManager.inMemory(cwd);
  for (const message of agent.state.messages) sessionManager.appendMessage(message as Message);
  // No reload or discovery: all resources come from the host's already validated selection.
  const resourceLoader = new DefaultResourceLoader({ cwd,agentDir: cwd,settingsManager,noExtensions: true,noSkills: true,noThemes: true,noContextFiles: true,noPromptTemplates: true });
  const session = new AgentSession({ agent,sessionManager,settingsManager,resourceLoader,modelRuntime,cwd,
    baseToolsOverride: Object.fromEntries(agent.state.tools.map(tool => [tool.name,tool])),initialActiveToolNames: agent.state.tools.map(tool => tool.name),allowedToolNames: agent.state.tools.map(tool => tool.name) });
  session.setAutoCompactionEnabled(false);
  return session;
}
