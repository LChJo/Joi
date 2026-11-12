import { createServer } from "node:http";
import { mkdtemp,mkdir,readdir,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { createAgentBrowserTools } from "../../src/main/infrastructure/pi/pi-agent-browser.js";
import { createAgentBrowserSession } from "../../src/main/infrastructure/pi/agent-browser-process.js";
import { PI_AGENT_BROWSER_TOOLS } from "../../src/main/domain/partners/pi-extension-tools.js";

const enabled = process.env.JOI_BROWSER_SMOKE === "1";
it.skipIf(!enabled)("CHAT-33–35 uses the real native browser on disposable localhost React content",async () => {
  const browserPath = process.env.JOI_BROWSER_SMOKE_EXECUTABLE;
  if (browserPath === undefined) throw new Error("Provide JOI_BROWSER_SMOKE_EXECUTABLE for the disposable browser test.");
  const directory = await mkdtemp(path.join(tmpdir(),"joi-browser-native-")),site = path.join(directory,"site");
  await mkdir(site);
  const bundle = createAgentBrowserTools(new Set(PI_AGENT_BROWSER_TOOLS),() => createAgentBrowserSession({ temporaryRoot: directory,browserPath }));
  const call = (name: string,input: unknown = {},signal?: AbortSignal) => {
    const tool = bundle.tools.find(tool => tool.name === name);
    if (tool === undefined) throw new Error("Missing native browser test tool.");
    return tool.execute(name,input,signal);
  };
  const text = async (name: string,input: unknown = {}) => JSON.stringify((await call(name,input)).content);
  await writeFile(path.join(site,"index.html"),'<html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  await writeFile(path.join(site,"app.js"),`import React from 'react';import {createRoot} from 'react-dom/client';
function Counter(){const [count,setCount]=React.useState(0);return React.createElement('main',null,
React.createElement('h1',null,'Local React fixture'),React.createElement('label',null,'Name',React.createElement('input',{id:'name'})),
React.createElement('button',{id:'increment',onClick:()=>{setCount(count+1);console.info('Synthetic browser event');void fetch('/fixture-api');}},'Count '+count));}
createRoot(document.getElementById('root')).render(React.createElement(Counter));`);
  await build({ root: site,configFile: false,logLevel: "silent",cacheDir: path.join(directory,"cache"),resolve: { alias: { "react-dom/client": fileURLToPath(import.meta.resolve("react-dom/client")),react: fileURLToPath(import.meta.resolve("react")) } },build: { outDir: path.join(directory,"dist"),emptyOutDir: true,minify: false } });
  const server = createServer((request,response) => {
    if (request.url === "/fixture-api") { response.setHeader("content-type","application/json");response.end('{"ok":true}');return; }
    const relative = new URL(request.url ?? "/","http://localhost").pathname;
    const file = path.join(directory,"dist",relative === "/" ? "index.html" : relative);
    if (!file.startsWith(path.join(directory,"dist") + path.sep)) { response.statusCode = 404;response.end();return; }
    response.setHeader("content-type",file.endsWith(".js") ? "text/javascript" : "text/html");
    void readFile(file).then(bytes => response.end(bytes),() => { response.statusCode = 404;response.end(); });
  });
  try {
    await new Promise<void>(resolve => { server.listen(0,"127.0.0.1",resolve); });
    const address = server.address();if (address === null || typeof address === "string") throw new Error("Missing fixture listener.");
    await call("browser_navigate",{ url: `http://127.0.0.1:${String(address.port)}` });
    expect(await text("browser_snapshot")).toContain("Count 0");
    await call("browser_fill",{ selector: "#name",text: "中文测试" });await call("browser_click",{ selector: "#increment" });
    expect(await text("browser_text",{ selector: "#increment" })).toContain("Count 1");
    expect(await text("browser_evaluate",{ javascript: "document.querySelector('#name').value" })).toContain("中文测试");
    expect(await text("browser_react")).toContain("Counter");
    expect(await text("browser_console")).toContain("Synthetic browser event");
    expect(await text("browser_network")).toContain("fixture-api");
    const screenshot = (await call("browser_screenshot")).content.find(item => item.type === "image");
    expect(screenshot?.type).toBe("image");
    if (screenshot?.type === "image") {
      await mkdir("test-results",{ recursive: true });await writeFile("test-results/agent-browser-local-react.png",Buffer.from(screenshot.data,"base64"));
    }
    await new Promise(resolve => setTimeout(resolve,31_500));
    expect(await text("browser_snapshot")).toContain("Count 1");
    const controller = new AbortController();
    const waiting = call("browser_wait_for",{ selector: "#never-created" },controller.signal).catch((error: unknown) => error);
    await new Promise(resolve => setTimeout(resolve,250));controller.abort();
    expect(await waiting).toMatchObject({ name: "AbortError" });
    await bundle.close();await expect(call("browser_snapshot")).rejects.toMatchObject({ code: "agent_browser_closed" });
    expect((await readdir(directory)).filter(name => name.startsWith("joi-browser-"))).toEqual([]);
  } finally { await bundle.close();server.closeAllConnections();await new Promise<void>(resolve => { server.close(() => { resolve(); }); });await rm(directory,{ recursive: true,force: true }); }
},90_000);
