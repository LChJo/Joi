import { _electron as electron, expect, test } from "@playwright/test";

test("workbench choice waits, reopens, and creates an edited project context", async () => {
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    expect(await application.evaluate(({ app }) => app.getPath("userData"))).toContain("joi-e2e");
    const page = await application.firstWindow();
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
        workbenches: [{ workbenchId: "news", name: "资讯调研", scopeSummary: "资讯与趋势调研。", updatedAt: new Date().toISOString() }],
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
    await dialog.getByRole("button", { name: "新建工作台" }).click();
    await expect(dialog.getByLabel("工作台名称")).toHaveValue("joi 工程维护工坊");
    await dialog.getByLabel("工作台名称").fill("joi 源码维护工坊");
    await page.screenshot({ path: "test-results/workbench-choice.png" });
    await dialog.getByRole("button", { name: "创建并继续" }).click();
    await expect(dialog).not.toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ name: "joi 源码维护工坊", bindInputId: "choice", questionId: "q1", questionVersion: 1 });
  } finally { await application.close(); }
});
