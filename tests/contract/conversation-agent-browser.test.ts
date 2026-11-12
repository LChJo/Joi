import { access,mkdir,mkdtemp,readdir,readFile,rm,stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentBrowserSession } from "../../src/main/infrastructure/pi/agent-browser-process.js";
import { createAgentBrowserTools } from "../../src/main/infrastructure/pi/pi-agent-browser.js";

afterEach(() => { vi.unstubAllEnvs(); });

it.each(["ready","failed-start"] as const)("CHAT-35 keeps long UTF-8 temporary roots isolated and cleans %s state",async mode => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-browser-ipc-")),nested = path.join(root,`nested-${"临时".repeat(16)}${"x".repeat(30)}`);
  await mkdir(nested);
  let browser: Awaited<ReturnType<typeof createAgentBrowserSession>> | undefined;
  try {
    const pending = createAgentBrowserSession({ temporaryRoot: nested,executable: { file: process.execPath,
      args: [fileURLToPath(new URL("../fixtures/agent-browser-cli.mjs",import.meta.url)),"--fixture-state",...(mode === "failed-start" ? ["--fixture-start-failure"] : [])] } });
    if (mode === "failed-start") await expect(pending).rejects.toMatchObject({ code: "agent_browser_start_failed" });
    else {
      browser = await pending;
      expect(JSON.parse((await browser.run(["snapshot"])).content[0]?.text ?? "{}")).toMatchObject({ privateConfig: true,secretInherited: false });
    }
    const state = JSON.parse(await readFile(path.join(nested,"fixture-state.json"),"utf8")) as { socketDirectory: string;socketPathBytes: number };
    if (mode === "ready" && process.platform !== "win32") {
      expect(state.socketPathBytes).toBeLessThanOrEqual(103);
      expect((await stat(state.socketDirectory)).mode & 0o777).toBe(0o700);
    }
    await browser?.close();
    await expect(access(state.socketDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(nested)).toEqual(["fixture-state.json"]);
  } finally { await browser?.close();await rm(root,{ recursive: true,force: true }); }
},15_000);

it("CHAT-34 runs the pinned local browser behind an isolated configuration without inherited credentials",async () => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-browser-contract-"));
  vi.stubEnv("FIXTURE_PROVIDER_API_KEY","synthetic-do-not-inherit");vi.stubEnv("AGENT_BROWSER_AUTO_CONNECT","1");
  const browser = await createAgentBrowserSession({ temporaryRoot: root,executable: { file: process.execPath,args: [fileURLToPath(new URL("../fixtures/agent-browser-cli.mjs",import.meta.url))] } });
  try {
    const result = await browser.run(["open","http://127.0.0.1:32101"]);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({ privateConfig: true,secretInherited: false,autoConnect: false,projectConfigRead: false });
  } finally { await browser.close();await rm(root,{ recursive: true,force: true }); }
},15_000);

it("CHAT-34 returns bounded text and inline screenshots from independent browser executions",async () => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-browser-output-"));
  const options = { temporaryRoot: root,executable: { file: process.execPath,args: [fileURLToPath(new URL("../fixtures/agent-browser-cli.mjs",import.meta.url))] } };
  const first = await createAgentBrowserSession(options),second = await createAgentBrowserSession(options);
  try {
    const a = JSON.parse((await first.run(["snapshot"])).content[0]?.text ?? "{}") as { session: string };
    const b = JSON.parse((await second.run(["snapshot"])).content[0]?.text ?? "{}") as { session: string };
    expect(a.session).not.toBe(b.session);
    const text = (await first.run(["fixture-long"])).content[0]?.text ?? "";
    expect(text.length).toBeLessThan(20_100);expect(text).toContain("omitted");expect(text).not.toContain("synthetic-secret-details");
    const image = (await first.screenshot()).content[0];
    expect(image).toMatchObject({ type: "image",mimeType: "image/png" });
    expect(JSON.stringify(image)).not.toContain(root);
  } finally { await first.close();await second.close();await rm(root,{ recursive: true,force: true }); }
},15_000);

it.each([["fixture-unknown","agent_browser_outcome_unknown"],["fixture-large","agent_browser_output_limit"]])("CHAT-35 stops %s without replaying or exposing raw errors",async (argument,code) => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-browser-failure-"));
  const browser = await createAgentBrowserSession({ temporaryRoot: root,executable: { file: process.execPath,args: [fileURLToPath(new URL("../fixtures/agent-browser-cli.mjs",import.meta.url))] } });
  try {
    await expect(browser.run(["eval",argument])).rejects.toMatchObject({ code });
    await expect(browser.run(["snapshot"])).rejects.toMatchObject({ code: "agent_browser_interrupted" });
  } finally { await browser.close();await rm(root,{ recursive: true,force: true }); }
},15_000);

it("CHAT-34 rejects option-shaped and extra tool arguments before starting a browser",async () => {
  const run = vi.fn().mockResolvedValue({ content: [{ type: "text",text: "Done" }],details: {} });
  const factory = vi.fn().mockResolvedValue({ run,screenshot: run,close: vi.fn() });
  const bundle = createAgentBrowserTools(new Set(["browser_fill","browser_navigate"]),factory);
  try {
    const fill = bundle.tools.find(tool => tool.name === "browser_fill");
    await expect(fill?.execute("option",{ selector: "#name",text: "--config" })).rejects.toMatchObject({ code: "agent_browser_arguments_invalid" });
    const navigate = bundle.tools.find(tool => tool.name === "browser_navigate");
    await expect(navigate?.execute("outside",{ url: "file:///private/example" })).rejects.toMatchObject({ code: "agent_browser_arguments_invalid" });
    await expect(navigate?.execute("extra",{ url: "http://localhost:3000",session: "personal" })).rejects.toMatchObject({ code: "agent_browser_arguments_invalid" });
    expect(factory).not.toHaveBeenCalled();
  } finally { await bundle.close(); }
});

it("CHAT-35 aborts an unknown command, closes owned processes and forbids further use",async () => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-browser-cancel-"));
  const browser = await createAgentBrowserSession({ temporaryRoot: root,executable: { file: process.execPath,args: [fileURLToPath(new URL("../fixtures/agent-browser-cli.mjs",import.meta.url))] } });
  const controller = new AbortController();
  try {
    await browser.run(["snapshot"]);
    const result = browser.run(["eval","fixture-hang"],controller.signal).catch((error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve,50));controller.abort();
    expect(await result).toMatchObject({ name: "AbortError" });
    await browser.close();await browser.close();
    await expect(browser.run(["snapshot"])).rejects.toMatchObject({ code: "agent_browser_closed" });
    expect(await readdir(root)).toEqual([]);
  } finally { await browser.close();await rm(root,{ recursive: true,force: true }); }
},15_000);

it("CHAT-35 requests a graceful browser close before terminating its owned daemon",async () => {
  const root = await mkdtemp(path.join(tmpdir(),"joi-browser-close-"));
  const browser = await createAgentBrowserSession({ temporaryRoot: root,executable: { file: process.execPath,args: [fileURLToPath(new URL("../fixtures/agent-browser-cli.mjs",import.meta.url))] } });
  try {
    await browser.run(["snapshot"]);await browser.close();
    expect(await readFile(path.join(root,"closed.json"),"utf8")).toBe("true");
  } finally { await browser.close();await rm(root,{ recursive: true,force: true }); }
},15_000);

it("CHAT-35 waits for startup and cleanup and never dispatches a tool after closing begins",async () => {
  const starting = Promise.withResolvers<Awaited<ReturnType<typeof createAgentBrowserSession>>>();
  const cleaning = Promise.withResolvers<undefined>();
  const run = vi.fn().mockResolvedValue({ content: [{ type: "text",text: "Done" }],details: {} });
  const bundle = createAgentBrowserTools(new Set(["browser_list_tabs"]),() => starting.promise);
  const command = bundle.tools[0]?.execute("call",{}).catch((error: unknown) => error);
  const first = bundle.close();let finished = false;
  const second = bundle.close().then(() => { finished = true; });
  starting.resolve({ run,screenshot: run,close: () => cleaning.promise });
  try {
    expect(await command).toMatchObject({ code: "agent_browser_closed" });
    await Promise.resolve();expect(run).not.toHaveBeenCalled();expect(finished).toBe(false);
  } finally { cleaning.resolve(undefined);await first;await second; }
});
