import { _electron as electron,expect,test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { setDesktopTestLocale } from "./locale";

test("CHAT-13/14 compact history, tooltip, archive tabs, restore and confirmed deletion", async () => {
  test.setTimeout(60_000);
  const app = await electron.launch({ args: ["."],env: { ...process.env,JOI_TEST: "1" } });
  try {
    const page = await app.firstWindow();await setDesktopTestLocale(page,"zh-CN");
    await page.getByLabel("管理密码").fill("archive fixture password");await page.getByLabel("确认密码").fill("archive fixture password");
    await page.getByRole("button",{ name: /保存并继续/ }).click();await page.getByRole("button",{ name: /先只用本机/ }).click();await page.getByRole("button",{ name: "暂时跳过" }).click();
    let archived = false,deleted = false;
    const wb = { workbenchId: "wb",name: "股票基本面与投资建议",scopeSummary: "Research",updatedAt: "2026-11-11" };
    const chat = { conversationId: "chat",workbenchId: "wb",title: "执行多级测试，检查对话和工作台中的完整归档流程",updatedAt: "2026-11-11T08:00:00Z",canArchive: true,turns: [] };
    await page.route("**/api/v1/**",async route => {
      const url = new URL(route.request().url()),path = url.pathname,method = route.request().method();let body: unknown;
      if (path === "/api/v1/workbenches") body = { items: [wb] };
      else if (path === "/api/v1/model-sources" || path === "/api/v1/partners" || path.endsWith("/skills")) body = { items: [] };
      else if (path.includes("conversation-inheritance")) body = { memoryCount: 0,evolutionRevisionId: null };
      else if (path === "/api/v1/conversations") body = { items: deleted || archived !== (url.searchParams.get("archived") === "true") ? [] : [{ ...chat,...(archived ? { archivedAt: chat.updatedAt } : {}) }] };
      else if (path.endsWith("/chat/archive")) { archived = true;body = { changed: true }; }
      else if (path.endsWith("/chat/restore")) { archived = false;body = { changed: true }; }
      else if (path.endsWith("/chat") && method === "DELETE") { deleted = true;body = { changed: true }; }
      else if (path.endsWith("/chat")) body = chat;
      else if (path === "/api/v1/joi/runtime") body = {};
      else if (path === "/api/v1/interactions") body = { items: [] };
      else { await route.continue();return; }
      await route.fulfill({ json: body });
    });
    await page.setViewportSize({ width: 1440,height: 900 });
    const nav = page.getByRole("navigation",{ name: "主导航" });
    await nav.getByRole("button",{ name: "对话",exact: true }).click();
    const row = page.getByRole("button",{ name: chat.title,exact: true });await expect(row).toBeVisible();
    await expect(page.getByText("和 AI 一起，把事情做好")).toHaveCount(0);
    expect((await row.boundingBox())?.height).toBeLessThanOrEqual(38);
    await row.hover();await expect(page.getByRole("tooltip")).toContainText(wb.name);await expect(page.getByRole("tooltip")).toContainText("2026");
    const tooltipBox = await page.getByRole("tooltip").boundingBox();expect(tooltipBox?.x).toBeGreaterThan(200);
    await mkdir("test-results",{ recursive: true });await page.screenshot({ path: "test-results/conversation-history-compact.png" });
    await page.getByRole("button",{ name: `对话操作 ${chat.title}` }).click();await page.getByRole("menuitem",{ name: "归档" }).click();
    await expect(row).toHaveCount(0);
    await nav.getByRole("button",{ name: "已归档",exact: true }).click();await page.getByRole("tab",{ name: "对话",exact: true }).click();
    await expect(page.getByRole("button",{ name: chat.title,exact: true })).toBeVisible();
    await page.getByRole("button",{ name: chat.title,exact: true }).click();await expect(page.getByRole("dialog",{ name: chat.title })).toBeVisible();
    await page.getByRole("button",{ name: "关闭",exact: true }).click();await page.screenshot({ path: "test-results/conversation-archive.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => page.getByRole("button",{ name: "恢复",exact: true }).evaluate(element => {
      const luminance = (color: string) => { const rgb = (color.match(/\d+/g) ?? []).slice(0,3).map(Number).map(value => { const s=value/255;return s<=.04045 ? s/12.92 : ((s+.055)/1.055)**2.4; });return .2126*(rgb[0] ?? 0)+.7152*(rgb[1] ?? 0)+.0722*(rgb[2] ?? 0); };
      const style=getComputedStyle(element),a=luminance(style.color),b=luminance(style.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
    })).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: "test-results/conversation-archive-dark.png",animations: "disabled" });await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button",{ name: "恢复",exact: true }).click();await expect(page.getByRole("button",{ name: chat.title,exact: true })).toHaveCount(0);
    await nav.getByRole("button",{ name: "对话",exact: true }).click();await expect(row).toBeVisible();
    await page.getByRole("button",{ name: `对话操作 ${chat.title}` }).click();await page.getByRole("menuitem",{ name: "归档" }).click();
    await nav.getByRole("button",{ name: "已归档",exact: true }).click();await page.getByRole("tab",{ name: "对话",exact: true }).click();
    await page.setViewportSize({ width: 390,height: 844 });await expect(page.getByRole("button",{ name: "删除",exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/conversation-archive-mobile.png" });
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth,overflow: [...document.querySelectorAll(".app-shell,.console-main,.archive-page,.chat-archive,.chat-archive-list,.chat-archive-list > article,.chat-archive-open")].map(element => ({ class: element.className,width: element.getBoundingClientRect().width,right: element.getBoundingClientRect().right })) }));
    expect(dimensions.width,JSON.stringify(dimensions)).toBeLessThanOrEqual(390);
    await page.getByRole("button",{ name: "删除",exact: true }).click();await page.getByRole("alertdialog").getByRole("button",{ name: "取消" }).click();expect(deleted).toBe(false);
    await page.getByRole("button",{ name: "删除",exact: true }).click();await page.getByRole("alertdialog").getByRole("button",{ name: "删除",exact: true }).click();
    await expect(page.getByRole("button",{ name: chat.title,exact: true })).toHaveCount(0);expect(deleted).toBe(true);
  } finally { await app.close(); }
});
