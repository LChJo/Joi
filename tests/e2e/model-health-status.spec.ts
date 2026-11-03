import { _electron as electron, expect, test } from "@playwright/test";
import { setDesktopTestLocale } from "./locale";
import type { JoiRuntimeDto } from "../../src/shared/joi";

test("model connection problems appear in the sidebar and clear after recovery", async () => {
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    expect(await application.evaluate(({ app }) => app.getPath("userData"))).toContain("joi-e2e");
    const page = await application.firstWindow();
    await setDesktopTestLocale(page, "zh-CN");
    let runtime: JoiRuntimeDto = { configured: true, status: "DEGRADED", modelHealth: { ready: 0, recovering: 2, unavailable: 2 } };
    await page.route("**/api/v1/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname === "/api/v1/auth/status" ? { configured: true }
        : pathname === "/api/v1/auth/bootstrap" ? { csrfToken: "disposable-model-health" }
        : pathname === "/api/v1/joi/runtime" ? runtime
        : pathname === "/api/v1/joi" ? { runtime, modelSources: [], partners: [{ partnerId: "health-fixture", capabilities: [],
          createdBy: "user", displayName: "Fixture", engine: "pi-core", inFlightCount: 0, kind: "local-pi", knowledgeDocCount: 0,
          lifecyclePolicy: "DRAIN", partnerRevisionId: "health-fixture-r1", registryRevision: 1, skills: [], status: "ACTIVE", tools: [] }],
          workbenches: [], workbenchChanges: [], work: [] }
        : pathname === "/api/v1/joi/home-feed" ? { goals: [], thinking: [], unassignedActions: [], workbenchChanges: [] }
        : pathname === "/api/v1/settings" ? { lan: { enabled: false, address: "", port: 43130, riskAccepted: false, availableAddresses: [], effective: { status: "disabled" } }, launchAtLogin: false }
        : { items: [] };
      await route.fulfill({ json: body });
    });
    await page.reload();
    const footer = page.locator(".sidebar footer");
    const warning = footer.getByRole("button", { name: "模型暂不可用，正在自动恢复" });
    await expect(warning).toBeVisible();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1280, 960, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(warning).toBeInViewport();
        expect(await warning.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: `test-results/e2e-model-health-${String(width)}-${colorScheme}.png` });
      }
    }
    runtime = { configured: true, status: "DEGRADED", modelHealth: { ready: 1, recovering: 1, unavailable: 1 } };
    await expect(footer.getByRole("button", { name: "部分模型暂时异常，正在自动恢复" })).toBeVisible();
    runtime = { configured: true, status: "READY", modelHealth: { ready: 2, recovering: 0, unavailable: 0 } };
    await expect(footer.locator(".model-health-status")).toHaveCount(0);
    runtime = { configured: true, status: "NEEDS_ATTENTION", modelHealth: { ready: 0, recovering: 0, unavailable: 1 } };
    await footer.getByRole("button", { name: "模型需要检查" }).click();
    await expect(page.getByRole("heading", { name: "joi 的设置" })).toBeVisible();
  } finally { await application.close(); }
});
