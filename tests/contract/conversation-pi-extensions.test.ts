/* Faux provider callbacks implement the asynchronous model boundary. */
/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp,rm,mkdir,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import { createModels,fauxProvider,fauxAssistantMessage,fauxText,fauxToolCall,getCurrentTools } from "@earendil-works/pi-ai";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";
import type { PartnerRunRequest } from "../../src/main/application/ports/partner-execution.js";
import type { PartnerSessionState } from "../../src/main/application/ports/partner-instances.js";
import { createConversationPiExtensions } from "../../src/main/infrastructure/pi/pi-conversation-extensions.js";

async function setup(tools?: string[]) {
  const directory = await mkdtemp(path.join(tmpdir(),"joi-pi-extensions-"));
  await mkdir(path.join(directory,"home"));
  vi.stubEnv("HOME",path.join(directory,"home"));vi.stubEnv("USERPROFILE",path.join(directory,"home"));
  vi.stubEnv("CC_SAFETY_NET_HOME",path.join(directory,"home","safety"));
  vi.stubEnv("OPENWIKI_CONFIG_DIR",path.join(directory,"home","wiki"));
  vi.stubEnv("KERNEL_API_KEY","");
  const faux = fauxProvider({ provider: "conversation-extensions" }),models = createModels();models.setProvider(faux.provider);
  const executed: string[] = [];
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {},workspacePath: directory }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },
    tools: { names: ["read","bash"],create: (_cwd,names) => names.map(name => ({ name,label: name,description: name,parameters: name === "read" ? Type.Object({ path: Type.String() }) : Type.Object({ command: Type.String() }),execute: async () => { executed.push(name);return { content: [{ type: "text",text: "Synthetic tool result" }],details: {} }; } })) } });
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-12T00:00:00Z",displayName: "Helper",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: tools ?? [],toolPolicyMode: tools === undefined ? "ALL" : "CUSTOM" });
  const request: PartnerRunRequest = { actionId: "turn",workbenchId: "wb",workId: "turn",contextSnapshotId: "snapshot",taskProjection: "Help",conversationId: "chat",subagentsEnabled: false };
  const run = (overrides: Partial<PartnerRunRequest> = {},sessionState?: PartnerSessionState) => runtime.runResidentTurn({ instanceId: "extensions",knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],revision,restoredMessages: null,request: { ...request,...overrides },...(sessionState === undefined ? {} : { sessionState }) });
  const close = async () => { runtime.evictFromMemory("extensions");vi.unstubAllEnvs();await rm(directory,{ recursive: true,force: true }); };
  return { directory,faux,runtime,executed,run,close };
}

it("CHAT-31 exposes only selected bundled tools to the real SDK and removes them on the next turn",async () => {
  const f = await setup();const seen: string[][] = [],prompts: string[] = [];
  f.faux.setResponses(Array.from({ length: 2 },() => context => { seen.push(getCurrentTools(context.messages).map(tool => tool.name));prompts.push(JSON.stringify(context.messages));return fauxAssistantMessage([fauxText("Done")]); }));
  try {
    const first = await f.run({ piExtensions: ["openwiki","browser-loop","cc-safety-net"] });
    expect(seen[0]).toEqual(expect.arrayContaining(["openwiki_begin","openwiki_search","openwiki_submit_page","browser_snapshot","browser_click","browser_list_tabs"]));
    expect(prompts[0]).toContain("Bundled OpenWiki workflow");
    await f.run({ actionId: "next",workId: "next",piExtensions: [] },{ engine: "pi-core",messages: first.messages ?? [] });
    expect(seen[1]?.some(name => name.startsWith("openwiki_") || name.startsWith("browser_"))).toBe(false);
    expect(prompts[1]).not.toContain("Bundled OpenWiki workflow");
    expect(f.executed).toEqual([]);
  } finally { await f.close(); }
},30_000);

it("CHAT-32 blocks destructive commands and secret file reads before execution only when Safety Net is enabled",async () => {
  const f = await setup();await writeFile(path.join(f.directory,".env"),"SYNTHETIC_PRIVATE_CREDENTIAL=do-not-display");
  f.faux.setResponses([
    context => { expect(JSON.stringify(context.messages).includes("CC Safety Net is active")).toBe(true);return fauxAssistantMessage([fauxToolCall("bash",{ command: "git reset --hard" }),fauxToolCall("read",{ path: ".env" })]); },
    fauxAssistantMessage([fauxText("Blocked operations reported")]),
    fauxAssistantMessage([fauxToolCall("read",{ path: ".env" })]),fauxAssistantMessage([fauxText("Done")]),
  ]);
  try {
    const result = await f.run({ piExtensions: ["cc-safety-net"] });
    expect(f.executed).toEqual([]);
    const results = (result.messages ?? []).filter(message => (message as { role: string }).role === "toolResult");
    expect(results).toHaveLength(2);
    expect(JSON.stringify(results)).toContain("CC Safety Net");
    expect(JSON.stringify(results)).not.toContain("do-not-display");
    await f.run({ actionId: "off",workId: "off",piExtensions: [] });
    expect(f.executed).toEqual(["read"]);
  } finally { await f.close(); }
},30_000);

it.each(["CUSTOM","READ"] as const)("CHAT-31 respects the %s ceiling when extension switches are on",async mode => {
  const f = await setup(mode === "CUSTOM" ? ["read"] : ["read","openwiki_search","browser_snapshot"]);let names: string[] = [];
  f.faux.setResponses([context => { names = getCurrentTools(context.messages).map(tool => tool.name);if (mode === "READ") expect(JSON.stringify(context.messages).includes("openwiki_submit_plan")).toBe(false);return fauxAssistantMessage([fauxText("Done")]); }]);
  try {
    await f.run({ piExtensions: ["openwiki","browser-loop"],...(mode === "READ" ? { workspaceExecution: { accessCeiling: "READ",phase: "READ_RUNNING",generation: 1 } } : {}) });
    expect(names).toContain("read");
    expect(names.includes("openwiki_search")).toBe(mode === "READ");
    expect(names).not.toContain("openwiki_begin");expect(names.some(name => name.startsWith("browser_"))).toBe(false);
  } finally { await f.close(); }
},30_000);

it("CHAT-31 requests a write lease before provisioning a browser and reports missing credentials after admission",async () => {
  const f = await setup();
  f.faux.setResponses([fauxAssistantMessage([fauxToolCall("browser_list_tabs",{})])]);
  try {
    const paused = await f.run({ piExtensions: ["browser-loop"],workspaceExecution: { accessCeiling: "WRITE",phase: "READ_RUNNING",generation: 1 } });
    expect(paused.status).toBe("SUSPENDED");
    expect(JSON.stringify(paused.messages).includes("Kernel API key")).toBe(false);
    f.faux.setResponses([fauxAssistantMessage([fauxToolCall("browser_list_tabs",{})]),fauxAssistantMessage([fauxText("Browser credentials are required")])]);
    const result = await f.run({ actionId: "credential-check",workId: "credential-check",piExtensions: ["browser-loop"] });
    expect(JSON.stringify(result.messages).includes("Browser Loop requires a Kernel API key")).toBe(true);
    expect(f.executed).toEqual([]);
  } finally { await f.close(); }
},30_000);

it("CHAT-32 binds the real OpenWiki lifecycle to a disposable Git root and resumes its durable run",async () => {
  const f = await setup();
  const git = (args: string[]) => promisify(execFile)("git",args,{ cwd: f.directory,env: { ...process.env,GIT_CONFIG_NOSYSTEM: "1",GIT_CONFIG_GLOBAL: path.join(f.directory,"no-global-config") } });
  const create = () => createConversationPiExtensions({ selected: ["openwiki"],allowedTools: ["openwiki_begin","openwiki_next_page"],cwd: f.directory });
  try {
    await git(["init","--quiet"]);
    await git(["-c","user.name=Fixture","-c","user.email=fixture@example.invalid","-c","commit.gpgsign=false","commit","--allow-empty","-m","Fixture"]);
    const first = await create(),begin = first.tools.find(tool => tool.name === "openwiki_begin");
    expect(begin).toBeDefined();
    await expect(begin?.execute("outside",{ mode: "init",root: path.dirname(f.directory) })).rejects.toMatchObject({ code: "workspace_path_forbidden" });
    const result = await begin?.execute("begin",{ mode: "init" });
    const view = JSON.parse(result?.content.find(item => item.type === "text")?.text ?? "{}") as { runId: string;phase: string };
    expect(view.phase).toBe("planning");expect(view.runId).toBeTypeOf("string");
    await first.close();
    const restored = await create();
    const resumed = await restored.tools.find(tool => tool.name === "openwiki_begin")?.execute("resume",{ mode: "init" });
    expect(JSON.parse(resumed?.content.find(item => item.type === "text")?.text ?? "{}")).toMatchObject({ runId: view.runId });
    await restored.close();
  } finally { await f.close(); }
},30_000);
