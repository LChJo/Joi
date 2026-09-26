import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { StatisticsDto, StatisticsQuery, UsageTotals } from "../../src/shared/statistics";

const totals = (input: number, output: number): UsageTotals => ({ input: Math.round(input), output: Math.round(output), total: Math.round(input) + Math.round(output), cacheRead: Math.floor(input / 3), cacheWrite: 0, reasoning: Math.floor(output / 4), cacheKnownRecords: 4, reasoningKnownRecords: 4, records: 5, knownRecords: 4, unknownRecords: 1, failedRecords: 1 });

function fixture(query: StatisticsQuery): StatisticsDto {
  const daily: StatisticsDto["daily"] = [];
  for (let cursor = Date.parse(`${query.from}T00:00:00Z`); cursor <= Date.parse(`${query.to}T00:00:00Z`); cursor += 86_400_000) {
    const index = daily.length;
    daily.push({ ...totals(8_000 + index * 1_130, 1_300 + (index % 7) * 600), date: new Date(cursor).toISOString().slice(0, 10) });
  }
  const aggregate = totals(daily.reduce((sum, day) => sum + day.input, 0), daily.reduce((sum, day) => sum + day.output, 0));
  return {
    query, collectedSince: `${query.from}T00:00:00Z`, updatedAt: `${query.to}T09:00:00Z`, collectionDegraded: false,
    overview: { ...aggregate, completedGoals: 12 }, daily,
    hourly: Array.from({ length: 168 }, (_, index) => ({ ...totals((index % 11) * 900, (index % 7) * 400), weekday: Math.floor(index / 24), hour: index % 24 })),
    models: [
      { ...totals(aggregate.input * .7, aggregate.output * .7), engine: "pi", modelId: "research-model", modelKey: "model-a", sourceName: "研究模型" },
      { ...totals(aggregate.input * .3, aggregate.output * .3), engine: "codex", modelId: "coding-model", modelKey: "model-b", sourceName: "开发模型" },
    ],
    workbenches: [{ ...aggregate, workbenchId: "statistics-workbench", name: "产品研究", archived: false, completedGoals: 12, failedGoals: 1, waitingGoals: 2 }],
    purposes: [{ ...totals(aggregate.input * .75, aggregate.output * .75), purpose: "partner" }, { ...totals(aggregate.input * .2, aggregate.output * .2), purpose: "orchestration" }, { ...totals(aggregate.input * .05, aggregate.output * .05), purpose: "evolution" }],
    goals: [{ ...aggregate, goalId: "statistics-goal", title: "整理研究结论", workbenchId: "statistics-workbench", workbenchName: "产品研究", status: "completed" }],
    filters: { models: [{ engine: "pi", modelId: "research-model", modelKey: "model-a", sourceName: "研究模型" }, { engine: "codex", modelId: "coding-model", modelKey: "model-b", sourceName: "开发模型" }], workbenches: [{ workbenchId: "statistics-workbench", name: "产品研究", archived: false }] },
  };
}

test("statistics navigation, filters, hover tooltips, goal routing and desktop themes", async () => {
  test.setTimeout(90_000);
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    expect(await application.evaluate(({ app }) => app.getPath("userData"))).toContain("joi-e2e");
    const page = await application.firstWindow();
    const queries: StatisticsQuery[] = [];
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      let body: unknown = { items: [] };
      if (url.pathname === "/api/v1/auth/status") body = { configured: true };
      else if (url.pathname === "/api/v1/auth/bootstrap") body = { csrfToken: "disposable-statistics-csrf" };
      else if (url.pathname === "/api/v1/diagnostics") body = {};
      else if (url.pathname === "/api/v1/joi") body = { workbenchChanges: [], workbenches: [], partners: [], modelSources: [], work: [], runtime: { configured: true, status: "READY" } };
      else if (url.pathname === "/api/v1/joi/home-feed") body = { goals: [{ agentCount: 0, workbench: { workbenchId: "statistics-workbench", name: "产品研究" }, canDelete: false, goalId: "statistics-goal", title: "整理研究结论", status: "COMPLETED", updatedAt: new Date().toISOString(), work: { active: 0, completed: 1, failed: 0, total: 1 } }], thinking: [], unassignedActions: [] };
      else if (url.pathname === "/api/v1/statistics") {
        const query = Object.fromEntries(url.searchParams) as unknown as StatisticsQuery;
        queries.push(query); body = fixture(query);
      }
      await route.fulfill({ json: body });
    });
    await page.reload();
    await page.getByRole("button", { name: "统计", exact: true }).click();
    await expect(page.getByRole("heading", { name: "用量统计" })).toBeVisible();
    await expect(page.locator(".statistics-bar-input")).toHaveCount(30);
    await page.getByRole("button", { name: "最近 7 天", exact: true }).click();
    await expect(page.locator(".statistics-bar-input")).toHaveCount(7);
    await page.getByRole("combobox", { name: "工作台", exact: true }).selectOption("statistics-workbench");
    await expect.poll(() => queries.at(-1)?.workbenchId).toBe("statistics-workbench");
    // Calendar days show a popup tooltip on hover now, not a click-to-drilldown button.
    const day = queries.at(-1)?.to;
    if (day === undefined) throw new Error("statistics_query_missing");
    const dayCell = page.locator(`.statistics-day[aria-label^="${day}"]`).first();
    await expect(dayCell).toHaveAttribute("aria-label", /Token/);
    await expect(page.getByRole("button", { name: new RegExp(`查看 ${day}`) })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "当日明细" })).toHaveCount(0);
    await dayCell.hover();
    await expect(page.locator(".app-tooltip")).toContainText(day);
    await page.getByRole("button", { name: "时段热图", exact: true }).click();
    await expect(page.locator(".statistics-hourly [role=img]")).toHaveCount(168);
    await mkdir("test-results", { recursive: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join("test-results", "statistics-hourly-1440.png"), fullPage: true });
    await page.locator(".statistics-hourly [role=img]").first().focus();
    await expect(page.locator(".statistics-hourly [role=img]").first()).toBeFocused();
    await page.getByRole("button", { name: "日历热图", exact: true }).click();
    await page.getByRole("button", { name: "最近 30 天", exact: true }).click();
    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      for (const width of [768, 960, 1440]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => window.scrollTo(0, 0));
        const dimensions = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
        expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
        await page.screenshot({ path: path.join("test-results", `statistics-${colorScheme}-${String(width)}.png`), fullPage: true });
      }
    }
    await page.getByRole("button", { name: "打开目标 整理研究结论" }).click();
    await expect(page.getByRole("dialog", { name: "产品研究 的目标详情" })).toBeVisible();
  } finally { await application.close(); }
});
