import { _electron as electron, expect, test } from "@playwright/test";
import { setDesktopTestLocale } from "./locale";
import type { JoiGoalCardDto, JoiSnapshotDto } from "../../src/shared/joi";

test("C2 home keeps compact targets, a narrow expanding composer and reachable actions", async () => {
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    expect(await application.evaluate(({ app }) => app.getPath("userData"))).toContain("joi-e2e");
    const page = await application.firstWindow();
    await application.evaluate(({ app }) => app.setAccessibilitySupportEnabled(true));
    expect(await application.evaluate(({ app }) => app.isAccessibilitySupportEnabled())).toBe(true);
    await setDesktopTestLocale(page, "zh-CN");
    const goals: JoiGoalCardDto[] = Array.from({ length: 3 }, (_, index) => ({
      agentCount: 2, canArchive: index > 0, canDelete: index > 0, goalId: `c2-${String(index)}`,
      status: index === 0 ? "RUNNING" : "COMPLETED", title: `目标 ${String(index + 1)}：保留较长标题和完整阅读入口`,
      updatedAt: "2026-10-20T00:00:00Z", workbench: { workbenchId: "fixture", name: index === 2 ? "a_very_long_workbench_name_".repeat(6) : "工程工作台" },
      work: { active: index === 0 ? 1 : 0, completed: index === 0 ? 1 : 2, failed: 0, total: 2 },
      ...(index === 0 ? {} : { completionSummary: "# 结果概要\n\n" + "完成验证与资料整理。\n\n".repeat(300) + "完整结果末尾" }),
    }));
    const snapshot: JoiSnapshotDto = {
      workbenchChanges: [], workbenches: [], modelSources: [], work: [], runtime: { configured: true, status: "READY" },
      partners: ["one", "two"].map(partnerId => ({ partnerId, capabilities: [], createdBy: "user", displayName: partnerId,
        engine: "pi-core", inFlightCount: 0, kind: "local-pi", knowledgeDocCount: 0, lifecyclePolicy: "DRAIN",
        partnerRevisionId: partnerId, registryRevision: 1, skills: [], status: "ACTIVE", tools: [] })),
    };
    await page.route("**/api/v1/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname === "/api/v1/auth/status" ? { configured: true }
        : pathname === "/api/v1/auth/bootstrap" ? { csrfToken: "disposable-c2-csrf" }
        : pathname === "/api/v1/joi" ? snapshot
        : pathname === "/api/v1/joi/home-feed" ? { goals, thinking: [], unassignedActions: [] }
        : { items: [] };
      await route.fulfill({ json: body });
    });
    await page.reload();
    await expect(page.locator(".joi-goal-card")).toHaveCount(3);
    expect(await page.locator(".joi-goal-result-copy").evaluateAll(elements => elements.every(element => element.childElementCount === 0 && element.textContent.length <= 321))).toBe(true);
    const input = page.getByLabel("给 joi 输入", { exact: true });
    const composer = page.locator(".joi-composer");
    await expect(input).not.toBeFocused();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1280, 960, 768]) {
        await page.setViewportSize({ width, height: 900 });
        await page.getByRole("heading", { name: "现在想让 joi 做什么？" }).click();
        const compact = await composer.boundingBox();
        expect(compact?.height).toBeLessThanOrEqual(70);
        expect(compact?.width).toBeLessThanOrEqual(681);
        expect(900 - ((compact?.y ?? 0) + (compact?.height ?? 0))).toBeLessThanOrEqual(20);
        const feed = page.locator(".joi-feed-single");
        if (width === 1280) expect((await feed.boundingBox())?.width).toBeGreaterThan((compact?.width ?? 0) + 80);
        const gap = await feed.evaluate(element => parseFloat(getComputedStyle(element).rowGap));
        expect(gap).toBeLessThanOrEqual(8);
        await expect(page.locator(".joi-goal-open .workbench-orb").first()).toHaveText("工程");
        const open = page.locator(".joi-goal-open").first();
        const title = open.locator(".joi-goal-title");
        await open.hover();
        expect(await open.evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
        expect(await title.evaluate(element => getComputedStyle(element).color)).toBe(await page.locator(".joi-goal-result-link").first().evaluate(element => getComputedStyle(element).color));
        await page.getByRole("heading", { name: "现在想让 joi 做什么？" }).hover();
        expect(await title.evaluate(element => getComputedStyle(element).color)).not.toBe(await page.locator(".joi-goal-result-link").first().evaluate(element => getComputedStyle(element).color));
        await open.focus();
        expect(await open.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
        await page.getByRole("heading", { name: "现在想让 joi 做什么？" }).click();
        expect(await page.locator(".joi-goal-card").first().evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
        expect((await page.locator(".joi-goal-result-preview").first().boundingBox())?.height).toBeLessThanOrEqual(64);
        await expect(page.locator(".joi-goal-result-copy").first()).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await feed.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await expect(page.locator(".joi-goal-card").last()).toBeInViewport({ ratio: 1 });
        await input.fill("保留草稿\n第二行");
        await page.getByRole("heading", { name: "现在想让 joi 做什么？" }).click();
        expect((await composer.boundingBox())?.height).toBeGreaterThan((compact?.height ?? 0) + 30);
        await expect(input).toHaveValue("保留草稿\n第二行");
        await input.fill("");
        await page.getByRole("heading", { name: "现在想让 joi 做什么？" }).click();
        await feed.evaluate(element => { element.scrollTop = 0; });
        await page.screenshot({ path: `test-results/e2e-home-c2-${String(width)}-${colorScheme}.png` });
      }
    }
    const historyGoal = goals.find(goal => goal.status === "COMPLETED");
    if (historyGoal === undefined) throw new Error("Missing completed fixture");
    for (let index = 3; index < 14; index += 1) goals.push({ ...historyGoal, goalId: `history-${String(index)}`, title: `历史目标 ${String(index)}` });
    await page.reload();
    await expect(page.locator(".joi-goal-card")).toHaveCount(14);
    const last = page.locator(".joi-goal-card").last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport({ ratio: 1 });
    await last.getByRole("button", { name: /更多操作/u }).click();
    const remove = page.getByRole("menuitem", { name: "移除" });
    await expect(remove).toBeInViewport({ ratio: 1 });
    expect(await remove.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
    })).toBe(true);
    await page.keyboard.press("Escape");
    await input.focus();
    await page.getByLabel("给 joi 添加附件").setInputFiles({ name: "plan.txt", mimeType: "text/plain", buffer: Buffer.from("disposable") });
    await page.getByRole("heading", { name: "现在想让 joi 做什么？" }).click();
    await expect(page.locator(".joi-file-summary")).toContainText("plan.txt");
    expect((await composer.boundingBox())?.height).toBeGreaterThan(90);
  } finally {
    await application.close();
  }
});

test("task and result headers keep long titles readable and actions horizontal", async () => {
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    expect(await application.evaluate(({ app }) => app.getPath("userData"))).toContain("joi-e2e");
    const page = await application.firstWindow();
    await setDesktopTestLocale(page, "zh-CN");
    const goal: JoiGoalCardDto = {
      agentCount: 0, canDelete: true, completionSummary: "## 核对结果\n\n" + "合成验证内容，完整结果可以继续阅读。\n\n".repeat(30),
      goalId: "long-title", status: "COMPLETED", title: "在任务项目中核对附件、分析问题并回传结论，保留完整资料和必要证据。".repeat(6),
      updatedAt: "2026-10-20T00:00:00Z", completedAt: "2026-10-20T00:00:00Z",
      workbench: { workbenchId: "fixture", name: "工程工作台", projectLabel: "ai mana front debug" },
      work: { active: 0, completed: 1, failed: 0, total: 1 },
    };
    await page.route("**/api/v1/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname === "/api/v1/auth/status" ? { configured: true }
        : pathname === "/api/v1/auth/bootstrap" ? { csrfToken: "disposable-header-csrf" }
        : pathname === "/api/v1/joi" ? { workbenchChanges: [], workbenches: [], modelSources: [], work: [], partners: [], runtime: { configured: true, status: "READY" } }
        : pathname === "/api/v1/joi/home-feed" ? { goals: [goal], thinking: [], unassignedActions: [] }
        : pathname.includes("/goals/") ? { goalId: goal.goalId, fullTitle: goal.title }
        : { items: [] };
      await route.fulfill({ json: body });
    });
    await page.reload();
    await expect(page.locator(".workbench-orb").first()).toHaveText("aima");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [1280, 768, 480]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator(".joi-goal-result-preview").click();
        const dialog = page.getByRole("dialog");
        const checkHeader = async () => {
          const heading = dialog.locator(".joi-goal-detail-title h1");
          await expect(heading).toBeVisible();
          const typography = await heading.evaluate(element => {
            const style = getComputedStyle(element);
            return { size: style.fontSize, lineHeight: style.lineHeight, weight: style.fontWeight, height: element.getBoundingClientRect().height };
          });
          expect(typography.size).toBe("19px");
          expect(typography.lineHeight).toBe("28.5px");
          expect(typography.weight).toBe("600");
          expect(typography.height).toBeLessThanOrEqual(58);
          const header = dialog.locator(".joi-goal-detail-header");
          expect((await header.boundingBox())?.height).toBeLessThanOrEqual(185);
          const body = dialog.locator(".joi-goal-drawer-body");
          expect((await body.boundingBox())?.height).toBeGreaterThan(450);
          expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        };
        await checkHeader();
        expect(await dialog.locator(".joi-goal-result .joi-md").evaluate(element => getComputedStyle(element).fontSize)).toBe("14px");
        for (const label of ["查看详情", "关闭"]) {
          const button = dialog.getByRole("button", { name: label, exact: true });
          await expect(button).toBeInViewport({ ratio: 1 });
          expect((await button.boundingBox())?.height).toBeLessThanOrEqual(40);
          expect(await button.evaluate(element => getComputedStyle(element).whiteSpace)).toBe("nowrap");
        }
        await page.screenshot({ path: `test-results/e2e-result-header-${String(width)}-${colorScheme}.png`, animations: "disabled" });
        await dialog.getByRole("button", { name: "查看详情", exact: true }).click();
        await checkHeader();
        await page.screenshot({ path: `test-results/e2e-task-header-${String(width)}-${colorScheme}.png`, animations: "disabled" });
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await expect(dialog).not.toBeVisible();
      }
    }
  } finally { await application.close(); }
});
