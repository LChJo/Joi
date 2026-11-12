/* External browser APIs are replaced at their public boundary. */
/* eslint-disable @typescript-eslint/require-await */
import { Browsers } from "@onkernel/sdk/resources/browsers/browsers";
import { LoopExecutionResources } from "@onkernel/browser-loop";
import { createBrowserLoopTools } from "../../src/main/infrastructure/pi/pi-browser-loop.js";
import { createModels,fauxProvider,fauxAssistantMessage,fauxToolCall,fauxText } from "@earendil-works/pi-ai";
import { PiPartnerEngineRuntime } from "../../src/main/infrastructure/pi/pi-partner-engine-runtime.js";
import { createPartnerRevision } from "../../src/main/domain/partners/partner.js";

const browser = { session_id: "synthetic-browser",cdp_ws_url: "ws://127.0.0.1:1",created_at: "2026-11-12T00:00:00Z",headless: true,stealth: false };

afterEach(() => { vi.restoreAllMocks();vi.unstubAllEnvs(); });

it("CHAT-32 lazily creates one browser, forwards cancellation and always closes owned resources",async () => {
  vi.stubEnv("KERNEL_API_KEY","synthetic-key");
  const create = vi.spyOn(Browsers.prototype,"create").mockResolvedValue(browser as never);
  const remove = vi.spyOn(Browsers.prototype,"deleteByID").mockResolvedValue(undefined);
  const dispose = vi.spyOn(LoopExecutionResources.prototype,"dispose").mockResolvedValue(undefined);
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const,text: "Synthetic tabs" }],details: { statusText: "Synthetic tabs" } }));
  vi.spyOn(LoopExecutionResources.prototype,"materialize").mockImplementation(spec => ({ spec,execute }));
  const extensions = await createBrowserLoopTools(new Set(["browser_list_tabs"])),tool = extensions.tools[0];
  try {
    expect(create).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    await tool?.execute("call-1",{},signal);await tool?.execute("call-2",{},signal);
    expect(create).toHaveBeenCalledTimes(1);expect(execute).toHaveBeenLastCalledWith({},signal);
  } finally { await extensions.close(); }
  await extensions.close();
  expect(dispose).toHaveBeenCalledTimes(1);expect(remove).toHaveBeenCalledExactlyOnceWith("synthetic-browser");
  await expect(tool?.execute("closed",{})).rejects.toMatchObject({ code: "browser_loop_closed" });
});

it("CHAT-32 waits for in-flight provisioning on cancellation and deletes the browser created after shutdown starts",async () => {
  vi.stubEnv("KERNEL_API_KEY","synthetic-key");
  const pending = Promise.withResolvers<never>();
  const create = vi.spyOn(Browsers.prototype,"create").mockReturnValue(pending.promise as never);
  const remove = vi.spyOn(Browsers.prototype,"deleteByID").mockResolvedValue(undefined);
  const dispose = vi.spyOn(LoopExecutionResources.prototype,"dispose").mockResolvedValue(undefined);
  const materialize = vi.spyOn(LoopExecutionResources.prototype,"materialize");
  const extensions = await createBrowserLoopTools(new Set(["browser_list_tabs"])),controller = new AbortController();
  const result = extensions.tools[0]?.execute("call",{},controller.signal).catch((error: unknown) => error);
  await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  controller.abort();const closing = extensions.close();pending.resolve(browser as never);
  await closing;expect(await result).toMatchObject({ name: "AbortError" });
  expect(materialize).not.toHaveBeenCalled();expect(dispose).toHaveBeenCalledTimes(1);expect(remove).toHaveBeenCalledExactlyOnceWith("synthetic-browser");
});

it("CHAT-32 retains a failed provisioning attempt instead of automatically repeating an unknown side effect",async () => {
  vi.stubEnv("KERNEL_API_KEY","synthetic-key");
  const create = vi.spyOn(Browsers.prototype,"create").mockRejectedValue(new Error("Synthetic connection lost"));
  const remove = vi.spyOn(Browsers.prototype,"deleteByID").mockResolvedValue(undefined);
  const extensions = await createBrowserLoopTools(new Set(["browser_list_tabs"])),tool = extensions.tools[0];
  try {
    await expect(tool?.execute("first",{})).rejects.toThrow("Synthetic connection lost");
    await expect(tool?.execute("retry",{})).rejects.toThrow("Synthetic connection lost");
    expect(create).toHaveBeenCalledTimes(1);expect(remove).not.toHaveBeenCalled();
  } finally { await extensions.close(); }
});

it("CHAT-32 closes the cloud browser even when child settlement fails during execution cleanup",async () => {
  vi.stubEnv("KERNEL_API_KEY","synthetic-key");
  vi.spyOn(Browsers.prototype,"create").mockResolvedValue(browser as never);
  const remove = vi.spyOn(Browsers.prototype,"deleteByID").mockResolvedValue(undefined);
  vi.spyOn(LoopExecutionResources.prototype,"dispose").mockResolvedValue(undefined);
  vi.spyOn(LoopExecutionResources.prototype,"materialize").mockImplementation(spec => ({ spec,execute: async () => ({ content: [{ type: "text",text: "Synthetic tabs" }],details: { statusText: "Synthetic tabs" } }) }));
  const faux = fauxProvider({ provider: "browser-cleanup" }),models = createModels();models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("browser_list_tabs",{})]),fauxAssistantMessage([fauxText("Done")])]);
  const runtime = new PiPartnerEngineRuntime({ contexts: { loadForExecution: async () => ({ promptSection: "",sanitized: {} }) },prompts: { read: async () => null },
    resolver: { resolve: async () => ({ model: faux.getModel(),models,thinkingLevel: "off" }) },sources: { selectInitial: async turnId => ({ turnId,modelId: "m",modelRevisionId: "mr",sourceId: "s",sourceRevisionId: "sr" }) },tools: { names: [],create: () => [] } });
  const settle = vi.fn().mockResolvedValueOnce([]).mockImplementation(async () => { throw new Error("Synthetic child settlement failure"); });
  runtime.setSubagents({ start: async () => { throw new Error("No child expected"); },list: async () => [],cancel: async () => undefined,settle });
  const revision = createPartnerRevision({ capabilities: [],createdAt: "2026-11-12",displayName: "Fixture",kind: "local-pi",partnerId: "p",partnerRevisionId: "r",registryRevision: 1,skills: [],tools: [],toolPolicyMode: "ALL" });
  try {
    await expect(runtime.runResidentTurn({ instanceId: "cleanup",revision,knowledgeSection: "",skillSection: "",skillEnvironmentKeys: [],restoredMessages: null,
      request: { actionId: "cleanup-turn",workId: "cleanup-turn",workbenchId: "wb",contextSnapshotId: "snapshot",taskProjection: "Inspect browser",conversationId: "chat",piExtensions: ["browser-loop"] } })).rejects.toThrow();
    expect(remove).toHaveBeenCalledExactlyOnceWith("synthetic-browser");
  } finally { runtime.evictFromMemory("cleanup"); }
});
