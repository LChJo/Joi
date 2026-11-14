import { _electron as electron,expect,test } from "@playwright/test";
import { mkdir } from "node:fs/promises";

test("a browser without the desktop bridge can read and send conversations at desktop and phone sizes", async () => {
  test.setTimeout(60_000);
  const app = await electron.launch({ args: ["."],env: { ...process.env,JOI_TEST: "1" } });
  try {
    const desktop = await app.firstWindow();
    await desktop.waitForURL(/^http:/);
    const origin = new URL(desktop.url()).origin;
    const context = app.context();
    await context.addInitScript(() => localStorage.setItem("joi.uiLocale","zh-CN"));
    const requests: string[] = [];
    const chat = { conversationId: "browser-chat",workbenchId: "wb",title: "已有跨端对话",updatedAt: "2026-11-14",turns: [{ turnId: "turn",text: "原问题",status: "COMPLETED",createdAt: "2026-11-14",config: { partnerId: "joi-chat",partnerName: "joi",networkId: "network",networkName: "网络",modelName: "Model",skills: [],attachmentIds: [] },artifacts: [],entries: [{ entryId: "reply",kind: "MARKDOWN",role: "AGENT",text: "浏览器可以继续这条对话。" }] }] };
    await context.route("**/api/v1/**",async route => {
      const url = new URL(route.request().url()),path = url.pathname;
      requests.push(path);
      let body: unknown = {};
      if (path === "/api/v1/auth/status") body = { configured: true };
      else if (path === "/api/v1/auth/login") body = { csrfToken: "synthetic-browser-grant" };
      else if (path === "/api/v1/workbenches") body = { items: [{ workbenchId: "wb",name: "跨端项目" }] };
      else if (path === "/api/v1/model-sources") body = { items: [{ sourceId: "network",displayName: "网络",status: "READY",activeModel: { id: "Model" } }] };
      else if (path === "/api/v1/partners" || path.endsWith("/skills") || path === "/api/v1/interactions") body = { items: [] };
      else if (path === "/api/v1/conversations" && route.request().method() === "POST") {
        const input = route.request().postDataJSON() as { text: string };
        body = { ...chat,turns: [...chat.turns,{ ...chat.turns[0],turnId: "second",text: input.text,entries: [{ entryId: "second",kind: "MARKDOWN",role: "AGENT",text: "手机浏览器发送成功。" }] }] };
      } else if (path === "/api/v1/conversations") body = { items: [chat] };
      else if (path === "/api/v1/conversations/browser-chat") body = chat;
      else if (path.startsWith("/api/v1/conversation-inheritance")) body = { memoryCount: 0,evolutionRevisionId: null };
      else if (path.startsWith("/api/v1/conversation-workspaces")) { await route.fulfill({ status: 403,json: { code: "desktop_required" } });return; }
      else if (path !== "/api/v1/joi/runtime") { await route.continue();return; }
      await route.fulfill({ json: body });
    });
    const pending = app.waitForEvent("window");
    await app.evaluate(({ BrowserWindow },url) => { const window = new BrowserWindow({ webPreferences: { contextIsolation: true,nodeIntegration: false } });void window.loadURL(url); },origin);
    const browser = await pending;
    const errors: string[] = [];
    browser.on("pageerror",error => errors.push(error.name));
    await browser.getByLabel("管理密码").fill("synthetic browser password");
    await browser.locator(".access-form button[type=submit]").click();
    await expect(browser.locator(".console-main")).toBeVisible();
    expect(await browser.evaluate(() => window.digitalLifeDesktop === undefined)).toBe(true);
    await browser.getByRole("navigation").getByRole("button",{ name: "对话",exact: true }).click();
    await browser.getByText("已有跨端对话",{ exact: true }).click();
    await expect(browser.getByText("浏览器可以继续这条对话。")).toBeVisible();
    await expect(browser.getByRole("button",{ name: "显示或收起工作区" })).toHaveCount(0);
    for (const [width,height] of [[1440,900],[390,844],[320,640],[640,390]]) {
      await browser.setViewportSize({ width: width ?? 390,height: height ?? 844 });
      const composer = browser.getByRole("textbox",{ name: "消息",exact: true });
      await expect(composer).toBeVisible();
      const box = await composer.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? -1)).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0)+(box?.width ?? 0)).toBeLessThanOrEqual((width ?? 390)+1);
      expect((box?.y ?? 0)+(box?.height ?? 0)).toBeLessThanOrEqual((height ?? 844)+1);
      expect(await browser.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth+1)).toBe(true);
    }
    await browser.setViewportSize({ width: 1440,height: 900 });
    await expect(browser.locator(".conversation-history")).toBeVisible();
    await browser.setViewportSize({ width: 390,height: 844 });
    await expect(browser.locator(".conversation-history")).toBeHidden();
    await browser.getByRole("textbox",{ name: "消息",exact: true }).fill("手机浏览器继续");
    await browser.getByRole("button",{ name: "发送消息",exact: true }).click();
    await expect(browser.getByText("手机浏览器发送成功。")).toBeVisible();
    await mkdir("test-results",{ recursive: true });
    await browser.screenshot({ path: "test-results/browser-conversation-phone.png" });
    expect(requests.some(path => path.startsWith("/api/v1/conversation-workspaces"))).toBe(false);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
