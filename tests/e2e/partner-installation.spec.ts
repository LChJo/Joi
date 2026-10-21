import { _electron as electron, expect, test } from "@playwright/test";
import { setDesktopTestLocale } from "./locale";

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
