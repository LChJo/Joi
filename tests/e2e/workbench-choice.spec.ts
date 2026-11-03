import { setDesktopTestLocale } from "./locale";
import { _electron as electron, expect, test } from "@playwright/test";

test("workbench choice waits, reopens, and creates a prepared project context in one click", async () => {
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    expect(await application.evaluate(({ app }) => app.getPath("userData"))).toContain("joi-e2e");
    const page = await application.firstWindow();
    await setDesktopTestLocale(page, "zh-CN");
    let pending = true;
    const requests: Record<string, unknown>[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      let body: unknown = { items: [] };
      if (url.pathname === "/api/v1/auth/status") body = { configured: true };
      else if (url.pathname === "/api/v1/auth/bootstrap") body = { csrfToken: "disposable-choice-csrf" };
      else if (url.pathname === "/api/v1/diagnostics") body = {};
      else if (url.pathname === "/api/v1/joi") body = {
        workbenchChanges: [], partners: [], modelSources: [], work: [], runtime: { configured: true, status: "READY" },
        workbenches: Array.from({ length: 12 }, (_, index) => ({ workbenchId: `news-${String(index)}`, name: `资讯调研 ${String(index)}`, scopeSummary: "资讯与趋势调研。", updatedAt: new Date().toISOString() })),
      };
      else if (url.pathname === "/api/v1/joi/home-feed") body = { goals: [], thinking: [], unassignedActions: pending ? [{
        inputId: "choice", acceptedAt: new Date().toISOString(), status: "CLARIFICATION_REQUIRED",
        clarificationReasonCode: "workbench_selection_invalid", questionId: "q1", questionVersion: 1,
        workbenchProposal: { name: "joi 工程维护工坊", projectLabel: "joi", scopeSummary: "源码及工程文档维护。" },
      }] : [] };
      else if (url.pathname === "/api/v1/workbenches" && route.request().method() === "POST") {
        const draft = route.request().postDataJSON() as Record<string, unknown>;
        requests.push(draft); pending = false;
        body = { workbenchId: "created", name: draft.name, scopeSummary: draft.scopeSummary, updatedAt: new Date().toISOString() };
      }
      await route.fulfill({ json: body });
    });
    await page.reload();
    const dialog = page.getByRole("dialog", { name: "选择工作台" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "稍后选择" }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole("button", { name: "选择工作台", exact: true }).click();
    const choices = dialog.getByRole("group", { name: "选择新工作台方案" });
    await expect(choices.getByRole("button")).toHaveCount(2);
    await expect(choices.getByRole("button", { name: "手动新建" })).toBeVisible();
    await expect(dialog.getByLabel("工作台名称")).toHaveCount(0);
    for (const size of [{ width: 1280, height: 900 }, { width: 768, height: 640 }]) {
      await page.setViewportSize(size);
      await expect(choices.getByRole("button").first()).toBeInViewport();
      await expect(choices.getByRole("button").last()).toBeInViewport();
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: "test-results/workbench-choice.png" });
    await choices.getByRole("button", { name: "手动新建" }).click();
    await expect(dialog.getByLabel("工作台名称")).toHaveValue("");
    await dialog.getByLabel("工作台名称").fill("自建工程工坊");
    await dialog.getByLabel("工程名称").fill("joi");
    await dialog.getByLabel("工作范围").fill("工程文档与源码维护。");
    await dialog.getByRole("button", { name: "返回选择" }).click();
    await choices.getByRole("button", { name: "手动新建" }).click();
    await expect(dialog.getByLabel("工作台名称")).toHaveValue("自建工程工坊");
    expect(requests).toHaveLength(0);
    await page.screenshot({ path: "test-results/workbench-manual.png" });
    await dialog.getByRole("button", { name: "返回选择" }).click();
    await choices.getByRole("button", { name: "创建 joi 工程维护工坊 并继续" }).click();
    await expect(dialog).not.toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ name: "joi 工程维护工坊", bindInputId: "choice", questionId: "q1", questionVersion: 1 });
  } finally { await application.close(); }
});
