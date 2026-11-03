import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("a quarter-million-file goal uses one folder row and requests its Explorer action", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(tmpdir(), "joi-e2e-artifacts-"));
  const entry = path.join(root, "main.cjs");
  await writeFile(entry, `
const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
app.setPath('userData', ${JSON.stringify(path.join(root, "userdata"))});
app.whenReady().then(() => {
  const renderer = ${JSON.stringify(path.resolve("dist/renderer"))};
  const server = createServer(async (req,res) => {
    const pathname = new URL(req.url,'http://localhost').pathname;
    if(pathname.startsWith('/api/v1/')) {
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({configured:true,csrfToken:'disposable-artifact-csrf',uiLocale:'zh-CN',workbenchChanges:[],workbenches:[],partners:[],modelSources:[],work:[],goals:[],thinking:[],unassignedActions:[],runtime:{configured:true,status:'READY'}}));return;
    }
    const target=path.resolve(renderer,'.'+(pathname==='/'?'/index.html':pathname));
    if(!target.startsWith(renderer+path.sep)){res.writeHead(404);res.end();return;}
    try { const bytes=await readFile(target);res.writeHead(200,{'content-type':target.endsWith('.html')?'text/html':target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'application/octet-stream'});res.end(bytes); }
    catch {res.writeHead(404);res.end();}
  });
  server.listen(0,'127.0.0.1',()=>{
    const origin='http://127.0.0.1:'+server.address().port;
    ipcMain.handle('desktop:runtime-info',()=>({apiOrigin:origin,platform:process.platform,productName:'joi',version:'test',uiLocale:'zh-CN',systemLanguages:['zh-CN']}));
    ipcMain.handle('desktop:create-bootstrap-nonce',()=>({nonce:'disposable-artifact-nonce',expiresAt:new Date(Date.now()+60000).toISOString()}));
    new BrowserWindow({width:1180,height:760,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,preload:${JSON.stringify(path.resolve("dist/electron/preload/index.cjs"))}}}).loadURL(origin);
  });
  app.on('window-all-closed',()=>{server.close();app.quit();});
});
`);
  const application = await electron.launch({ args: [entry], env: { ...process.env, JOI_TEST: "1" } });
  try {
    const page = await application.firstWindow();
    const artifacts = [{ artifactId: "work_result_artifact:synthetic:0", kind: "DIRECTORY", name: "out", mimeType: "inode/directory", directory: "out", fileCount: 251_159, size: 0 }];
    const goal = { goalId: "synthetic-goal", agentCount: 1, canDelete: true, status: "COMPLETED", title: "大量文件结果", updatedAt: "2026-11-02T00:00:00Z",
      workbench: { workbenchId: "synthetic-bench", name: "测试工作台" }, work: { active: 0, completed: 1, failed: 0, total: 1 },
      completionSummary: "# 独立正文\n\n" + "合成的完整交付说明。\n\n".repeat(200), artifacts, artifactCount: 251_159 };
    let openRequest: unknown;
    await page.route("**/api/v1/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/open")) openRequest = route.request().postDataJSON();
      const value = url.pathname.endsWith("/open") ? { opened: true } : url.pathname.endsWith("/artifacts") ? { items: artifacts }
        : url.pathname.endsWith("/home-feed") ? { goals: [goal], thinking: [], unassignedActions: [] }
        : { configured: true, csrfToken: "disposable-artifact-csrf", uiLocale: "zh-CN", workbenchChanges: [], workbenches: [], modelSources: [], partners: [], work: [], runtime: { configured: true, status: "READY" } };
      await route.fulfill({ json: value });
    });
    await page.reload();
    await page.locator(".joi-goal-result-preview").waitFor();
    const started = Date.now();
    await page.locator(".joi-goal-result-preview").click();
    const reader = page.locator(".joi-result-drawer");
    await expect(reader.getByRole("heading", { name: "独立正文", exact: true })).toBeVisible();
    const nodes = await reader.locator("*").count();
    await test.info().attach("artifact-performance.json", { body: JSON.stringify({ totalArtifacts: goal.artifactCount, openMillis: Date.now() - started, nodes }), contentType: "application/json" });
    expect(nodes).toBeLessThan(1_000);
    await expect(reader.locator(".agent-artifact")).toHaveCount(1);
    await expect(reader.getByText("out", { exact: true })).toBeVisible();
    await reader.getByRole("button", { name: "打开产物 out", exact: true }).click();
    await expect.poll(() => openRequest).toEqual({ mode: "OPEN_FOLDER", source: "GOAL", sourceId: "synthetic-goal" });
    await expect(reader.getByText("file-0.json", { exact: true })).toHaveCount(0);
    await expect(reader.getByRole("heading", { name: "独立正文", exact: true })).toBeAttached();
    await page.setViewportSize({ width: 480, height: 800 });
    expect(await reader.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(reader.getByRole("button", { name: "下一页", exact: true })).toHaveCount(0);
    await page.screenshot({ path: "tmp/artifact-scope-20261103/folder-result-480.png" });
  } finally { await application.close(); }
});
