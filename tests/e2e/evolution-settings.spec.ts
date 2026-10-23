import { _electron as electron, expect, test } from "@playwright/test";
import path from "node:path";
import { setDesktopTestLocale } from "./locale";
import type { EvolutionLearningDto, EvolutionStatusDto } from "../../src/shared/evolution";

test("evolution shows current learning without retired material across sizes and themes", async () => {
  test.setTimeout(60_000);
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    const page = await application.firstWindow();
    await setDesktopTestLocale(page, "zh-CN");
    await page.getByLabel("管理密码").fill("disposable evolution password");
    await page.getByLabel("确认密码").fill("disposable evolution password");
    await page.getByRole("button", { name: /保存并继续/u }).click();
    await page.getByRole("button", { name: /先只用本机/u }).click();
    await page.getByRole("button", { name: "暂时跳过" }).click();
    await page.getByRole("button", { name: "工作台", exact: true }).click();
    await page.getByRole("button", { name: "创建工作台" }).click();
    await page.getByLabel("名称", { exact: true }).fill("学习设计预览");
    await page.getByLabel("工程名称", { exact: true }).fill("界面验证");
    await page.getByLabel("职责范围", { exact: true }).fill("隔离界面验证");
    await page.getByLabel("人格摘要", { exact: true }).fill("仅用于隔离测试。");
    await page.getByRole("button", { name: "保存工作台" }).click();
    const learning: EvolutionLearningDto = {
      version: 2, evaluatorVersion: "hidden-evaluator", stage: "DIAGNOSING", blockers: ["not_idle", "daily_candidate_limit"],
      globalBudget: { enabled: true, paused: false, dailyCallLimit: 150, callsUsedToday: 99, tokensToday: 137008 },
      participation: { enabled: true, paused: false }, cases: { development: 4, sealed: 0, defects: 4 },
      experiment: { id: "fixture", calls: 99, tokens: 137008, reason: "insufficient_gain" }, appliedGoals: 0, methods: [],
    };
    const status: EvolutionStatusDto = { workbenchId: "fixture", dailyCallLimit: 150, callsUsedToday: 99, evidenceCount: 4,
      evaluableCount: 4, poolEvaluable: 4, poolVerificationFailed: 0, activeRevisionId: null, reason: "insufficient_gain",
      runRequestedAt: null, lastVerdict: null, versions: [], learning };
    await page.route("**/api/v1/workbenches/*/evolution", route => route.fulfill({ json: {
      ...status, workbenchId: new URL(route.request().url()).pathname.split("/").at(-2),
    } }));
    await page.route("**/api/v1/evolution", route => route.fulfill({ json: {
      workbenches: 1, enabled: 1, evaluating: 0, canary: 0, active: 0, revalidationRequired: 0,
      poolEvaluable: 4, poolVerificationFailed: 0, batches: [], learning,
    } }));
    const openEvolution = async (english = false) => {
      await page.getByRole("button", { name: english ? "Workbenches" : "工作台", exact: true }).click();
      await page.getByRole("button", { name: `${english ? "Open workbench" : "打开工作台"} 学习设计预览`, exact: true }).click();
      await page.getByRole("tab", { name: english ? "Automatic evolution" : "自主进化", exact: true }).click();
    };
    await openEvolution();
    await expect(page.getByRole("region", { name: "当前进展" })).toBeVisible();
    await expect(page.getByText("最近一次评测", { exact: true })).toBeVisible();
    await expect(page.getByText(/旧版|干跑|hidden-evaluator/u)).toHaveCount(0);
    await expect(page.getByRole("progressbar")).toHaveAttribute("value", "99");
    for (const width of [1280, 960, 768]) {
      await page.setViewportSize({ width, height: 1100 });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
        const panel = page.locator(".workbench-evolution-panel");
        const overflow = await panel.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
        expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await panel.screenshot({ path: path.resolve(`test-results/evolution-${String(width)}-${colorScheme}.png`) });
      }
    }
    await page.setViewportSize({ width: 768, height: 1100 });
    const refresh = async () => {
      await page.getByRole("tab", { name: /Agent/u }).click();
      await page.getByRole("tab", { name: "自主进化", exact: true }).click();
    };
    learning.stage = "CANARY";
    learning.blockers = [];
    learning.experiment = { id: "fixture", calls: 99, tokens: null, reason: "canary" };
    learning.appliedGoals = 8;
    learning.methods = [{ revisionId: "active", scope: "GLOBAL", module: "planning", status: "ACTIVE",
      createdAt: "2026-10-23", benefit: "quality", baselineSuccesses: 12, candidateSuccesses: 15, evaluatedRuns: 30,
      candidateGoals: 5, controlGoals: 5 }, { revisionId: "canary", scope: "WORKBENCH", module: "completion", status: "CANARY",
      createdAt: "2026-10-23", benefit: null, baselineSuccesses: 15, candidateSuccesses: 15, evaluatedRuns: 30,
      candidateGoals: 3, controlGoals: 5 }];
    await refresh();
    const methods = page.getByRole("region", { name: "已采用的方法" });
    await expect(methods.getByText("任务规划", { exact: true })).toBeVisible();
    await methods.getByText("评测依据", { exact: true }).first().click();
    await expect(methods.getByText("候选目标 5 · 对照目标 5", { exact: true })).toBeVisible();
    await expect(methods.getByRole("button", { name: "回退当前策略并暂停" })).toHaveCount(2);
    await page.locator(".workbench-evolution-panel").screenshot({ path: path.resolve("test-results/evolution-methods-768-dark.png") });
    learning.stage = "PAUSED";
    learning.blockers = ["paused"];
    learning.globalBudget.paused = true;
    learning.participation.paused = true;
    await refresh();
    await expect(page.getByRole("button", { name: "恢复全局方法学习" })).toBeVisible();
    await expect(page.getByRole("button", { name: "恢复本工作台方法学习" })).toBeVisible();
    await expect(page.getByRole("button", { name: "立即评测一次" })).toBeDisabled();
    await page.locator(".workbench-evolution-panel").screenshot({ path: path.resolve("test-results/evolution-paused-768-dark.png") });
    learning.globalBudget.dailyCallLimit = 0;
    await refresh();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await page.locator(".workbench-evolution-panel").screenshot({ path: path.resolve("test-results/evolution-zero-budget-768-dark.png") });
    await setDesktopTestLocale(page, "en");
    await openEvolution(true);
    await page.setViewportSize({ width: 768, height: 1100 });
    await expect(page.getByRole("region", { name: "Current progress" })).toBeVisible();
    await page.locator(".workbench-evolution-panel").screenshot({ path: path.resolve("test-results/evolution-768-en-dark.png") });
  } finally { await application.close(); }
});
