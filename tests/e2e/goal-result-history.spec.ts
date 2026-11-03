import { _electron as electron, expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setDesktopTestLocale } from "./locale";
import type { JoiGoalCardDto } from "../../src/shared/joi";
import type { GoalResultDto } from "../../src/shared/goal-results";

test("desktop history keeps an older body readable and exportable when a new result arrives", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(path.join(tmpdir(), "joi-e2e-history-"));
  const entry = path.join(root, "main.cjs");
  await writeFile(entry, `
const { app, BrowserWindow, ipcMain } = require('electron');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
app.setPath('userData', ${JSON.stringify(path.join(root, "userdata"))});
app.whenReady().then(() => {
  const renderer = ${JSON.stringify(path.resolve("dist/renderer"))};
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname.startsWith('/api/v1/')) {
      const value = pathname.endsWith('/auth/status') ? { configured: true }
        : pathname.endsWith('/auth/bootstrap') ? { csrfToken: 'disposable-history-csrf' }
        : pathname.endsWith('/settings') ? { uiLocale: 'zh-CN' }
        : { workbenchChanges: [], workbenches: [], modelSources: [], work: [], partners: [], goals: [], thinking: [], unassignedActions: [], runtime: { configured: true, status: 'READY' } };
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); return;
    }
    const target = path.resolve(renderer, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(renderer + path.sep)) { response.writeHead(404); response.end(); return; }
    try {
      const bytes = await readFile(target);
      response.writeHead(200, { 'content-type': target.endsWith('.html') ? 'text/html' : target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'application/octet-stream' }); response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  server.listen(0, '127.0.0.1', () => {
    const origin = 'http://127.0.0.1:' + server.address().port;
    ipcMain.handle('desktop:runtime-info', () => ({ apiOrigin: origin, platform: process.platform, productName: 'joi', version: 'test', uiLocale: 'zh-CN', systemLanguages: ['zh-CN'] }));
    ipcMain.handle('desktop:create-bootstrap-nonce', () => ({ nonce: 'disposable-history-nonce', expiresAt: new Date(Date.now() + 60000).toISOString() }));
    const window = new BrowserWindow({ width: 1280, height: 900, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: ${JSON.stringify(path.resolve("dist/electron/preload/index.cjs"))} } });
    window.loadURL(origin);
  });
  app.on('window-all-closed', () => { server.close(); app.quit(); });
});
`);
  const application = await electron.launch({ args: [entry], env: { ...process.env, JOI_TEST: "1" } });
  try {
    expect(await application.evaluate(({ app }) => app.getPath("userData"))).toContain("joi-e2e");
    const page = await application.firstWindow();
    await setDesktopTestLocale(page, "zh-CN");
    const results: GoalResultDto[] = Array.from({ length: 22 }, (_, index) => ({
      resultId: `result-${String(index)}`, goalId: "history-goal", completedAt: new Date(Date.UTC(2026, 10, 2 - index, 6)).toISOString(),
      status: index === 21 ? "COMPLETED_WITH_GAPS" : "COMPLETED", body: `# 第 ${String(index + 1)} 次正文\n\n${"完整的历史结果正文。\n\n".repeat(70)}历史全文末尾 ${String(index)}`,
    }));
    const latest = results[0];
    const older = results[21];
    if (latest === undefined || older === undefined) throw new Error("Missing history fixtures");
    let goal: JoiGoalCardDto = {
      agentCount: 0, canDelete: true, goalId: "history-goal", resultId: latest.resultId, status: "COMPLETED", title: "定时消息整理任务",
      completionSummary: latest.body, completedAt: latest.completedAt, updatedAt: latest.completedAt,
      workbench: { workbenchId: "history-bench", name: "消息工坊" }, work: { active: 0, completed: 0, failed: 0, total: 0 },
    };
    const exported: Record<string, unknown>[] = [];
    await page.route("**/api/v1/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/v1/result-exports") {
        exported.push(route.request().postDataJSON() as Record<string, unknown>);
        await route.fulfill({ json: { exportId: `export-${String(exported.length)}`, status: "completed", filenames: ["history"], count: 1 } });
        return;
      }
      const selected = results.find(result => url.pathname === `/api/v1/joi/goals/history-goal/results/${result.resultId}`);
      const body = url.pathname === "/api/v1/auth/status" ? { configured: true }
        : url.pathname === "/api/v1/auth/bootstrap" ? { csrfToken: "disposable-history-csrf" }
        : url.pathname === "/api/v1/joi" ? { workbenchChanges: [], workbenches: [], modelSources: [], work: [], partners: [], runtime: { configured: true, status: "READY" } }
        : url.pathname === "/api/v1/joi/home-feed" ? { goals: [goal], thinking: [], unassignedActions: [] }
        : url.pathname === "/api/v1/joi/goals/history-goal/results" ? url.searchParams.has("cursor")
          ? { items: results.slice(20).map(({ resultId, completedAt, status }) => ({ resultId, completedAt, status })) }
          : { items: results.slice(0, 20).map(({ resultId, completedAt, status }) => ({ resultId, completedAt, status })), nextCursor: "older-page" }
        : selected ?? { items: [] };
      await route.fulfill({ json: body });
    });
    await page.reload();
    await page.locator(".joi-goal-result-preview").click();
    await page.getByRole("button", { name: "历史结果", exact: true }).click();
    const history = page.getByRole("dialog", { name: "历史结果", exact: true });
    await expect(history.locator(".joi-history-entry")).toHaveCount(20);
    await history.getByRole("button", { name: "加载更多", exact: true }).click();
    await expect(history.locator(".joi-history-entry")).toHaveCount(22);
    const list = history.locator(".joi-history-list");
    for (const width of [1280, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await list.evaluate(element => { element.scrollTop = 0; });
      await history.getByRole("heading", { name: "历史结果", exact: true }).hover();
      expect(await history.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/e2e-history-list-${String(width)}.png`, animations: "disabled" });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await list.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const listPosition = await list.evaluate(element => element.scrollTop);
    expect(listPosition).toBeGreaterThan(0);
    await history.getByRole("button", { name: /已完成（有缺口）/u }).click();
    await expect(history.getByRole("heading", { name: "第 22 次正文", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(history.locator(".joi-goal-result")).not.toContainText(goal.title);
    await expect(history.getByRole("button", { name: "继续", exact: true })).toHaveCount(0);
    const updated = "新的正式交付正文";
    goal = { ...goal, resultId: "new-delivery", completionSummary: updated, updatedAt: "2026-11-02T07:00:00Z" };
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/joi/home-feed");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await refreshed;
    await expect(history.getByRole("heading", { name: "第 22 次正文", exact: true })).toBeVisible();
    await expect(history.locator(".joi-goal-result")).not.toContainText(updated);
    for (const width of [1280, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(history.getByRole("button", { name: "返回历史结果", exact: true })).toBeInViewport({ ratio: 1 });
      await expect(history.getByRole("button", { name: "导出全文", exact: true })).toBeInViewport({ ratio: 1 });
      expect(await history.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: `test-results/e2e-history-result-${String(width)}.png`, animations: "disabled" });
    }
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (body: string) => { Reflect.set(window, "testCopiedHistory", body); return Promise.resolve(); } } });
    });
    await history.getByRole("button", { name: "导出全文", exact: true }).click();
    await history.getByRole("menuitem", { name: "复制全文", exact: true }).click();
    await expect(history.getByRole("status")).toHaveText("已复制全文");
    expect(await page.evaluate(() => Reflect.get(window, "testCopiedHistory") as unknown)).toBe(older.body);
    for (const format of ["pdf", "png"]) {
      await history.getByRole("button", { name: "导出全文", exact: true }).click();
      await history.getByRole("menuitem", { name: `导出 ${format.toUpperCase()}`, exact: true }).click();
      await expect(history.getByRole("status")).toContainText("已保存 1 个文件");
      expect(exported.at(-1)).toMatchObject({ goalId: goal.goalId, resultId: older.resultId, format, digest: createHash("sha256").update(older.body).digest("hex") });
    }
    await history.getByRole("button", { name: "导出全文", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(history.getByRole("menu")).toHaveCount(0);
    await expect(history.getByRole("heading", { name: "第 22 次正文", exact: true })).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press("Escape");
    await expect(history.locator(".joi-history-entry")).toHaveCount(22);
    expect(await history.locator(".joi-history-list").evaluate(element => element.scrollTop)).toBe(listPosition);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await expect(page.getByRole("dialog").getByRole("button", { name: "查看详情", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally { await application.close(); }
});
