import { _electron as electron, expect, test } from "@playwright/test";
import { setDesktopTestLocale } from "./locale";
import { mkdir } from "node:fs/promises";
import { PI_AGENT_BROWSER_TOOLS } from "../../src/main/domain/partners/pi-extension-tools";

test("CHAT-41/43 partner tools group browser permissions in one default-off switch",async () => {
  const application = await electron.launch({ args: ["."],env: { ...process.env,JOI_TEST: "1" } });
  try {
    expect(await application.evaluate(({ app }) => app.getPath("userData"))).toContain("joi-e2e");
    const page = await application.firstWindow();await setDesktopTestLocale(page,"zh-CN");
    const partner = { partnerId: "browser-fixture",partnerRevisionId: "r1",displayName: "Tool permissions",capabilities: [],createdBy: "user",engine: "pi-core",inFlightCount: 0,kind: "local-pi",knowledgeDocCount: 0,lifecyclePolicy: "DRAIN",promptConfigured: false,registryRevision: 1,skills: [],status: "ACTIVE",tools: [],toolPolicyMode: "ALL" };
    let saved: unknown;
    await page.route("**/api/v1/**",async route => {
      const url = new URL(route.request().url());let body: unknown = { items: [] };
      if (url.pathname === "/api/v1/auth/status") body = { configured: true };
      else if (url.pathname === "/api/v1/auth/bootstrap") body = { csrfToken: "disposable-tool-fixture" };
      else if (url.pathname === "/api/v1/diagnostics") body = {};
      else if (url.pathname === "/api/v1/joi") body = { workbenchChanges: [],workbenches: [],partners: [partner],modelSources: [],work: [],runtime: { configured: true,status: "READY" } };
      else if (url.pathname === "/api/v1/joi/home-feed") body = { goals: [],thinking: [],unassignedActions: [] };
      else if (url.pathname === "/api/v1/partners") body = { items: [partner] };
      else if (url.pathname === "/api/v1/engines") body = { items: [{ available: true,id: "pi-core",tools: ["read","edit",...PI_AGENT_BROWSER_TOOLS] },{ available: true,id: "claude-code",tools: ["Bash","Read"] }] };
      else if (url.pathname === "/api/v1/partners/browser-fixture" && route.request().method() === "PATCH") { saved = route.request().postDataJSON() as unknown;body = partner; }
      await route.fulfill({ json: body });
    });
    await page.reload();await page.getByRole("navigation",{ name: "主导航" }).getByRole("button",{ name: "搭档",exact: true }).click();
    await page.getByRole("button",{ name: "编辑",exact: true }).click();await page.getByRole("tab",{ name: "高级" }).click();
    const tools = page.getByRole("group",{ name: "工具白名单" });
    await expect(tools.getByRole("checkbox",{ name: "read",exact: true })).toBeChecked();
    await expect(tools.getByRole("checkbox")).toHaveCount(2);
    const browser = tools.getByRole("switch",{ name: "Agent Browser",exact: true });
    await expect(tools.getByRole("switch")).toHaveCount(1);
    await expect(browser).not.toBeChecked();
    await expect(tools.getByRole("checkbox",{ name: /^browser_/ })).toHaveCount(0);
    await expect(tools.getByText(/openwiki/i)).toHaveCount(0);
    await page.setViewportSize({ width: 1100,height: 900 });
    expect(await tools.locator(".tool-choice span").evaluateAll(elements => elements.every(element => element.scrollWidth <= element.clientWidth && getComputedStyle(element).textOverflow !== "ellipsis"))).toBe(true);
    await mkdir("test-results",{ recursive: true });await tools.screenshot({ path: "test-results/partner-browser-permissions.png" });
    await browser.focus();await page.keyboard.press("Space");await expect(browser).toBeChecked();
    await page.keyboard.press("Space");await expect(browser).not.toBeChecked();
    await page.setViewportSize({ width: 960,height: 844 });
    await expect(browser).toBeVisible();
    expect(await browser.evaluate(element => { const rect=element.getBoundingClientRect();return { width: rect.width,height: rect.height }; })).toEqual({ width: 32,height: 18 });
    await page.emulateMedia({ colorScheme: "dark" });
    await browser.check();await expect(browser).toBeChecked();
    await browser.uncheck();await expect(browser).not.toBeChecked();
    await tools.screenshot({ path: "test-results/partner-browser-permissions-dark-compact.png" });
    await page.setViewportSize({ width: 1100,height: 900 });
    await tools.getByRole("checkbox",{ name: "read",exact: true }).uncheck();
    await expect(browser).not.toBeChecked();
    await page.getByRole("button",{ name: "全部开启",exact: true }).click();
    await expect(browser).toBeChecked();
    await page.getByRole("button",{ name: "全部关闭",exact: true }).click();
    await expect(browser).not.toBeChecked();
    await browser.check();
    await page.getByRole("button",{ name: "保存修改",exact: true }).click();
    await expect.poll(() => saved).toMatchObject({ toolPolicyMode: "CUSTOM",tools: [...PI_AGENT_BROWSER_TOOLS] });
  } finally { await application.close(); }
});

test("fresh partner catalog reflects a complete suite installation without remounting", async () => {
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    expect(await application.evaluate(({ app }) => app.getPath("userData"))).toContain("joi-e2e");
    const page = await application.firstWindow();
    await setDesktopTestLocale(page, "zh-CN");
    let installed = false;
    let installations = 0;
    const partners = ["one", "two"].map(id => ({
      partnerId: id, partnerRevisionId: `${id}-r1`, displayName: `Fixture ${id}`, capabilities: [],
      createdBy: "joi", engine: "pi-core", inFlightCount: 0, kind: "local-pi", knowledgeDocCount: 0,
      lifecyclePolicy: "DRAIN", promptConfigured: true, registryRevision: 1, skills: [], status: "ACTIVE", tools: [],
    }));
    await page.route("**/api/v1/**", async route => {
      const url = new URL(route.request().url());
      let body: unknown = { items: [] };
      if (url.pathname === "/api/v1/auth/status") body = { configured: true };
      else if (url.pathname === "/api/v1/auth/bootstrap") body = { csrfToken: "disposable-install-csrf" };
      else if (url.pathname === "/api/v1/diagnostics") body = {};
      else if (url.pathname === "/api/v1/joi") body = { workbenchChanges: [], workbenches: [], partners: installed ? partners : [], modelSources: [], work: [], runtime: { configured: true, status: "READY" } };
      else if (url.pathname === "/api/v1/joi/home-feed") body = { goals: [], thinking: [], unassignedActions: [] };
      else if (url.pathname === "/api/v1/partners") body = { items: installed ? partners : [] };
      else if (url.pathname === "/api/v1/scenario-packs") body = { items: [{
        id: "programming", title: "冷启动安装回归", blurb: "fixture", definitionVersion: 1,
        installedRoleCount: installed ? 2 : 0, totalRoleCount: 2, status: installed ? "ACTIVE" : "NOT_INSTALLED",
        source: { license: "fixture", repository: "joi/builtin", revision: "fixture" }, teams: [],
      }] };
      else if (url.pathname === "/api/v1/scenario-packs/programming/install") {
        installations++;
        installed = true;
        body = { installedRoleCount: 2, packId: "programming", status: "ACTIVE",
          outcomes: ["one", "two"].map(id => ({ roleId: id, partnerId: id, outcome: "CREATED" })) };
      }
      await route.fulfill({ json: body });
    });
    await page.reload();
    await page.getByRole("button", { name: "搭档", exact: true }).click();
    await expect(page.getByText("还没有搭档", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "场景预设" }).click();
    await page.getByRole("button", { name: /冷启动安装回归/u }).click();
    await page.getByRole("button", { name: "安装完整套件" }).click();
    await expect(page.getByText(/2\/2 位/u)).toBeVisible();
    await page.getByRole("tab", { name: "搭档目录" }).click();
    await expect(page.locator(".partner-card")).toHaveCount(2);
    await expect(page.getByText("Fixture one", { exact: true })).toBeVisible();
    await expect(page.getByText("Fixture two", { exact: true })).toBeVisible();
    await expect(page.getByText("还没有搭档", { exact: true })).toHaveCount(0);
    expect(installations).toBe(1);
  } finally { await application.close(); }
});
