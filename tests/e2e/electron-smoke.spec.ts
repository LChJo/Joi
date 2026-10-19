import { setDesktopTestLocale } from "./locale";
import { _electron as electron, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function seedReadyAgent(userDataDirectory: string): void {
  const database = new DatabaseSync(path.join(userDataDirectory, "runtime.sqlite"));
  const now = new Date().toISOString();
  try {
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    database.prepare(`
      INSERT INTO agent_credentials (credential_id, encrypted_blob, credential_version, created_at)
      VALUES ('credential_e2e', ?, 1, ?)`).run(new Uint8Array([1, 2, 3]), now);
    database.prepare(`
      INSERT INTO agent_connections
        (agent_connection_id, name, card_url, status, created_at, updated_at, description, skills_json,
         readiness, card_url_hash, credential_id, credential_version, origin_hash, last_validated_at)
      VALUES ('agent_e2e', 'Mana E2E', 'http://192.168.1.250/card.json', 'ACTIVE', ?, ?,
        'Disposable E2E readiness fixture', '["digital-life"]', 1, ?, 'credential_e2e', 1, ?, ?)`)
      .run(now, now, "a".repeat(64), "b".repeat(64), now);
    database.prepare(`
      INSERT INTO agent_card_snapshots
        (card_snapshot_id, agent_connection_id, card_url, card_url_hash, card_hash, name, description,
         rpc_url, origin, protocol_version, transport, authentication, streaming, skills_json, created_at)
      VALUES ('card_e2e', 'agent_e2e', 'http://192.168.1.250/card.json', ?, ?, 'Mana E2E',
        'Disposable E2E readiness fixture', 'http://192.168.1.250/rpc', 'http://192.168.1.250',
        '0.3.0', 'JSONRPC', 'bearer', 1, '["digital-life"]', ?)`)
      .run("a".repeat(64), "c".repeat(64), now);
    database.prepare("UPDATE agent_connections SET card_snapshot_id = 'card_e2e' WHERE agent_connection_id = 'agent_e2e'").run();
    database.prepare(`INSERT INTO model_source_credentials
      (provider_id, credential_type, encrypted_blob, credential_version, updated_at)
      VALUES ('joi-source:e2e', 'api_key', ?, 1, ?)`).run(new Uint8Array([4, 5, 6]), now);
    database.prepare(`INSERT INTO model_sources
      (source_id, status, active_source_revision_id, active_model_revision_id, created_at, updated_at)
      VALUES ('e2e', 'READY', NULL, NULL, ?, ?)`).run(now, now);
    database.prepare(`INSERT INTO model_source_revisions
      (source_revision_id, source_id, kind, access_mode, protocol, display_name, credential_ref, credential_version, created_at)
      VALUES ('source-revision-e2e', 'e2e', 'deepseek', 'api', 'openai', 'DeepSeek E2E', 'joi-source:e2e', 1, ?)`).run(now);
    database.prepare(`INSERT INTO model_source_model_revisions
      (model_revision_id, source_id, model_id, capability, preset_version, created_at)
      VALUES ('model-revision-e2e', 'e2e', 'deepseek-chat', 'release-tested', '2026-07-30', ?)`).run(now);
    database.prepare(`UPDATE model_sources
      SET active_source_revision_id = 'source-revision-e2e', active_model_revision_id = 'model-revision-e2e' WHERE source_id = 'e2e'`).run();
    database.prepare(`INSERT INTO model_source_health
      (source_id, status, updated_at, last_validated_at) VALUES ('e2e', 'READY', ?, ?)`).run(now, now);
    database.prepare("INSERT INTO model_source_order (source_id, position, is_primary) VALUES ('e2e', 0, 1)").run();
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function sidebarAppearance(page: Page) {
  return page.locator(".sidebar").evaluate((sidebar) => {
    const bounds = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const style = getComputedStyle(sidebar);
    return {
      background: style.backgroundColor,
      border: style.borderRightColor,
      bounds: bounds(sidebar),
      buttons: Array.from(sidebar.querySelectorAll("nav button"), (button) => {
        const buttonStyle = getComputedStyle(button);
        const icon = button.querySelector("svg");
        const label = button.querySelector("span");
        if (icon === null || label === null) throw new Error("Expected navigation icon and label.");
        const labelBounds = label.getBoundingClientRect();
        return {
          bounds: bounds(button),
          fontFamily: buttonStyle.fontFamily,
          fontSize: buttonStyle.fontSize,
          lineHeight: buttonStyle.lineHeight,
          gap: buttonStyle.gap,
          radius: buttonStyle.borderRadius,
          padding: buttonStyle.padding,
          icon: bounds(icon),
          label: { x: labelBounds.x, y: labelBounds.y, height: labelBounds.height },
        };
      }),
    };
  });
}

async function expectStableSidebar(page: Page): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "主导航" });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1280, 960, 768]) {
      await page.setViewportSize({ height: 760, width });
      await navigation.getByRole("button", { exact: true, name: "joi" }).click();
      await expect(page.locator(".joi-home")).toBeVisible();
      const baseline = await sidebarAppearance(page);
      for (const label of ["工作台", "搭档", "定时任务", "设置", "统计", "已归档", "joi"]) {
        await navigation.getByRole("button", { exact: true, name: label }).click();
        await expect(navigation.locator('[aria-current="page"]')).toHaveText(label);
        expect(await sidebarAppearance(page), `${colorScheme}/${String(width)}/${label} 的侧栏格式`).toEqual(baseline);
        if (width === 1280 && (label === "工作台" || label === "joi")) {
          await page.locator(".sidebar").screenshot({ path: path.resolve(`test-results/e2e-sidebar-${colorScheme}-${label === "joi" ? "home" : "workbench"}.png`) });
        }
      }
      await expectNoHorizontalOverflow(page);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("Electron completes setup, native workbench creation, and responsive joi-console paths", async () => {
  test.setTimeout(60_000);
  const skillsRoot = await mkdtemp(path.join(tmpdir(), "joi-e2e-skills-"));
  await mkdir(path.join(skillsRoot, "example"));
  await writeFile(path.join(skillsRoot, "example", "SKILL.md"), "---\nname: example\ndescription: Disposable skill for main Joi settings.\n---\nUse the test workflow.\n");
  const application = await electron.launch({ args: ["."], env: {
    ...process.env, JOI_TEST: "1", JOI_AGENTS_SKILLS_DIR: skillsRoot,
    JOI_CLAUDE_SKILLS_DIR: path.join(skillsRoot, "empty-claude"), JOI_CODEX_SKILLS_DIR: path.join(skillsRoot, "empty-codex"),
  } });

  try {
    const window = await application.firstWindow();
    await setDesktopTestLocale(window, "zh-CN");
    await expect(window).toHaveTitle("joi");
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isMenuBarVisible())).toBe(false);
    await expect(window.getByRole("heading", { name: "先帮 joi 设个密码。" })).toBeVisible();
    await window.getByLabel("管理密码").fill("correct horse battery staple");
    await window.getByLabel("确认密码").fill("correct horse battery staple");
    await window.getByRole("button", { name: /保存并继续/ }).click();
    await window.getByRole("button", { name: /先只用本机/ }).click();
    await window.getByRole("button", { name: "暂时跳过" }).click();
    await expect(window.getByRole("heading", { name: "joi需要链接到大模型网络" })).toBeVisible();
    const userDataDirectory = await application.evaluate(({ app }) => app.getPath("userData"));
    expect(userDataDirectory).toContain("joi-e2e");

    seedReadyAgent(userDataDirectory);
    await window.reload();
    const joiHomeTitle = window.getByRole("heading", { name: "现在想让 joi 做什么？" });
    await expect(joiHomeTitle).toBeVisible();
    expect((await joiHomeTitle.boundingBox())?.y).toBeGreaterThanOrEqual(16);
    await expectStableSidebar(window);

    await window.setViewportSize({ height: 760, width: 960 });
    await window.getByRole("button", { exact: true, name: "设置" }).click();
    const modelSource = window.locator(".model-source-item").filter({ hasText: "DeepSeek E2E" });
    await expect(modelSource).toBeVisible();
    expect(await modelSource.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(600);
    await expectNoHorizontalOverflow(window);
    await mkdir(path.resolve("test-results"), { recursive: true });
    await window.screenshot({ path: path.resolve("test-results/e2e-model-source-960.png") });

    await window.getByRole("tab", { name: "技能", exact: true }).click();
    const skill = window.getByRole("checkbox", { name: /example/ });
    await expect(skill).not.toBeChecked();
    await skill.check();
    await window.getByRole("button", { name: "保存技能选择" }).click();
    await expect(window.getByText("技能选择已保存，下次思考时生效。")).toBeVisible();
    await expectNoHorizontalOverflow(window);
    await window.screenshot({ path: path.resolve("test-results/e2e-joi-skills-960.png") });
    await window.getByRole("tab", { name: "模型网络", exact: true }).click();
    await window.getByRole("tab", { name: "技能", exact: true }).click();
    await expect(skill).toBeChecked();
    await skill.uncheck();
    await window.getByRole("button", { name: "保存技能选择" }).click();
    await expect(window.getByText("技能选择已保存，下次思考时生效。")).toBeVisible();
    await window.getByRole("tab", { name: "模型网络", exact: true }).click();

    await window.getByRole("button", { name: "添加网络" }).click();
    const embeddedNetworkTitle = window.getByRole("heading", { name: "joi需要链接到大模型网络" });
    await expect(embeddedNetworkTitle).toBeVisible();
    const embeddedNetworkTitleBox = await embeddedNetworkTitle.boundingBox();
    expect(embeddedNetworkTitleBox?.width).toBeGreaterThan(400);
    expect(embeddedNetworkTitleBox?.height).toBeLessThan(80);
    await expectNoHorizontalOverflow(window);
    await window.screenshot({ path: path.resolve("test-results/e2e-model-source-setup-960.png") });

    await window.getByRole("button", { exact: true, name: "搭档" }).click();
    await expect(window.getByText("Mana E2E")).toBeVisible();
    await window.getByRole("button", { name: "添加搭档" }).click();
    await window.getByRole("tab", { name: "高级" }).click();
    const toolChoices = window.getByRole("group", { name: "工具白名单" });
    await expect(toolChoices).toBeVisible();
    expect(await toolChoices.locator(".tool-choice").first().evaluate((element) => getComputedStyle(element).borderRadius)).toBe("8px");
    await window.screenshot({ path: path.resolve("test-results/e2e-tool-choices-960.png") });
    await window.getByRole("button", { exact: true, name: "工作台" }).click();

    expect(await window.evaluate(() => globalThis.innerWidth)).toBe(960);
    await expectNoHorizontalOverflow(window);
    await window.getByRole("button", { name: "创建工作台" }).click();
    await window.getByLabel("名称", { exact: true }).fill("栖光");
    await window.getByLabel("工程名称", { exact: true }).fill("长期事务");
    await window.getByLabel("职责范围", { exact: true }).fill("整理长期计划与事实");
    await window.getByLabel("人格摘要", { exact: true }).fill("尊重事实，持续整理长期事务。");
    await window.getByRole("button", { name: "保存工作台" }).click();
    await expect(window.getByText("栖光")).toBeVisible();
    await expectNoHorizontalOverflow(window);

    await window.getByRole("button", { name: "打开工作台 栖光" }).click();
    await window.getByRole("tab", { name: "自主进化" }).click();
    // Fresh installs require explicit opt-in before any background model budget is available.
    await expect(window.getByText("尚未启用自动进化")).toBeVisible();
    await expect(window.getByRole("radio", { name: "关（只记录经验）" })).toBeChecked();
    await window.getByRole("radio", { name: "低（每日 50 次）" }).click();
    await expect(window.getByText(/预算已设为「低」/u)).toBeVisible();
    await window.getByRole("radio", { name: "关（只记录经验）" }).click();
    await expect(window.getByText("已关闭评测预算，只记录经验。")).toBeVisible();
    await expect(window.getByText("尚未启用自动进化")).toBeVisible();
    await expectNoHorizontalOverflow(window);
    await window.screenshot({ path: path.resolve("test-results/e2e-evolution-960.png") });
    await window.getByRole("radio", { name: "低（每日 50 次）" }).click();
    await expect(window.getByText("正在积累可评价的经验")).toBeVisible();

    await window.getByRole("button", { exact: true, name: "joi" }).click();
    const composer = window.locator(".joi-composer");
    await expect(composer).toBeVisible();
    await expect(window.getByRole("button", { name: "joi 自主分发" })).toBeVisible();
    const composerBox = await composer.boundingBox();
    expect(composerBox).not.toBeNull();
    expect(760 - ((composerBox?.y ?? 0) + (composerBox?.height ?? 0))).toBeLessThanOrEqual(20);
    await window.screenshot({ path: path.resolve("test-results/e2e-joi-composer-960.png") });

    await window.getByRole("button", { exact: true, name: "工作台" }).click();
    await window.setViewportSize({ height: 900, width: 768 });
    expect(await window.evaluate(() => globalThis.innerWidth)).toBe(768);
    await expect(window.getByRole("heading", { exact: true, name: "工作台" })).toBeVisible();
    await window.getByRole("button", { name: "管理上下文 栖光" }).click();
    await expect(window.getByRole("heading", { name: "栖光" })).toBeVisible();
    await expect(window.getByRole("tab", { name: /上下文设置/u })).toHaveAttribute("aria-selected", "true");
    await window.getByRole("button", { name: "返回工作台列表" }).click();
    await window.getByRole("button", { name: "打开工作台 栖光" }).click();
    await expect(window.getByRole("tab", { name: /Agent/u })).toHaveAttribute("aria-selected", "true");
    await expect(window.getByRole("heading", { name: "还没有 Agent" })).toBeVisible();
    // AC-60: exercise the real built renderer with disposable HTTP projections.
    const agent = {
      agentId: "stream-e2e", workbenchId: "fixture", canDelete: false, createdAt: "2026-09-18T10:00:00Z",
      engine: "pi-core", lastActivityAt: "2026-09-18T10:00:00Z", partnerId: "fixture", partnerName: "滚动搭档",
      sessionPolicy: "EPHEMERAL", status: "RUNNING", transport: "LOCAL",
    };
    let messageCount = 125;
    let historyReads = 0;
    await window.route("**/api/v1/workbenches/*/agents**", async route => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith("/conversation")) { await route.fulfill({ json: { items: [agent] } }); return; }
      expect(url.searchParams.get("latest")).toBe("true");
      const before = Number(url.searchParams.get("cursor") ?? messageCount);
      if (url.searchParams.has("cursor")) historyReads += 1;
      const start = Math.max(0, before - 50);
      await route.fulfill({ json: { agent, ...(start > 0 ? { nextCursor: String(start) } : {}),
        items: Array.from({ length: before - start }, (_, i) => ({
          entryId: `stream-${String(start + i)}`, sequence: start + i, kind: "MARKDOWN", role: "AGENT",
          createdAt: new Date(Date.UTC(2026, 8, 18, 10, 0, start + i)).toISOString(), text: `执行记录 ${String(start + i)}`,
        })),
      } });
    });
    await window.getByRole("button", { name: "返回工作台列表" }).click();
    await window.getByRole("button", { name: "打开工作台 栖光" }).click();
    await window.getByRole("button", { name: /滚动搭档/u }).click();
    const stream = window.getByRole("log", { name: "Agent 执行记录" });
    await expect(stream.getByText("执行记录 124", { exact: true })).toBeInViewport();
    messageCount = 126;
    await expect(stream.getByText("执行记录 125", { exact: true })).toBeInViewport();
    await stream.evaluate(element => { element.scrollTop = 0; });
    await expect.poll(() => historyReads).toBeGreaterThan(0);
    await expect(stream.getByText("执行记录 25", { exact: true })).toBeAttached();
    await expect.poll(() => stream.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    messageCount = 127;
    await expect(stream.getByText("执行记录 126", { exact: true })).toBeAttached();
    await expect(stream.getByText("执行记录 126", { exact: true })).not.toBeInViewport();
    await window.getByRole("button", { name: "回到最新" }).click();
    await expect(stream.getByText("执行记录 126", { exact: true })).toBeInViewport();
    await window.screenshot({ path: path.resolve("test-results/e2e-agent-stream-latest.png") });
    await window.getByRole("button", { name: "返回 Agent 列表" }).click();
    let feedUnavailable = false;
    await window.route("**/api/v1/joi/home-feed", route => feedUnavailable
      ? route.fulfill({ status: 503, json: { error: { code: "test_feed_unavailable", message: "unavailable" } } })
      : route.fulfill({ json: {
      thinking: [], unassignedActions: [], goals: [{
        goalId: "stream-goal", title: "长任务执行记录", status: "RUNNING", agentCount: 1, canDelete: false,
        workbench: { workbenchId: "fixture", name: "栖光" }, updatedAt: agent.createdAt,
        work: { active: 1, completed: 0, failed: 0, total: 2 },
        harness: { destination: "完整验证最新消息的可见性。".repeat(24), topPaths: [], decisionCount: 1, fogCount: 0, currentLayer: 1 },
      }],
    } }));
    await window.getByRole("button", { exact: true, name: "joi" }).click();
    const runningGoal = window.locator(".joi-goal-card").filter({ hasText: "长任务执行记录" });
    await expect(runningGoal.getByText("执行中", { exact: true })).toBeVisible();
    feedUnavailable = true;
    await expect(window.getByText("任务状态暂时无法刷新，已保留上次成功获取的数据。")).toBeVisible();
    await expect(runningGoal.getByText("执行中", { exact: true })).toBeVisible();
    await expect(runningGoal.getByText("排队中", { exact: true })).toHaveCount(0);
    await expect(runningGoal.getByText("已完成", { exact: true })).toHaveCount(0);
    feedUnavailable = false;
    await window.getByRole("button", { name: "重新加载任务状态" }).click();
    await expect(window.getByText("任务状态暂时无法刷新，已保留上次成功获取的数据。")).toHaveCount(0);
    await window.getByText("长任务执行记录", { exact: true }).click();
    const goalStream = window.getByRole("log", { name: "Agent 执行记录" });
    await expect(goalStream.getByText("执行记录 126", { exact: true })).toBeInViewport();
    await window.screenshot({ animations: "disabled", path: path.resolve("test-results/e2e-goal-stream-latest.png") });
    const fullGoalTitle = `${"完整目标阅读与复制。".repeat(160)}最后一条要求`;
    let largeMap = false;
    await window.route("**/api/v1/joi/goals/stream-goal/detail?*", route => {
      const offset = Number(new URL(route.request().url()).searchParams.get("offset") ?? 0);
      return route.fulfill({ json: {
      goalId: "stream-goal", fullTitle: fullGoalTitle,
      ...(largeMap && offset + 50 < 167 ? { nextOffset: offset + 50 } : {}),
      harness: {
        destination: "交付中英文 README，确保事实可追溯、图片引用有效。", mapStatus: "ACTIVE", revision: largeMap ? 4 : 3, currentLayer: largeMap ? 32 : 3,
        pathCount: largeMap ? 167 : 7, decisionCount: largeMap ? 32 : 1, fogCount: 2,
        paths: Array.from({ length: largeMap ? Math.min(50, 167 - offset) : 7 }, (_, item) => {
          const index = offset + item;
          return { pathId: `map-path-${String(index)}`, layer: largeMap ? 32 - Math.floor(index * 32 / 167) : index < 3 ? 1 : index < 6 ? 2 : 3,
          title: ["源码核实", "配图资产", "整理术语", "中文文档", "英文文档", "图片验收", "独立复核"][index] ?? `历史路径 ${String(index)}`,
          status: "CLOSED", workStatus: index === 6 ? "FAILED" : "COMPLETED", ...(index === 6 ? { resolvedDecisionId: "decision" } : {}) };
        }),
        decisions: Array.from({ length: largeMap ? 32 : 1 }, (_, index) => ({ decisionId: index === 0 ? "decision" : `decision-${String(index)}`, kind: "APPROACH", summary: index === 0 ? "以源码证据为准" : `复盘决策 ${String(index)}`, detail: "复核异常需要单独展示，不能把路径关闭当作任务成功。", createdAt: agent.createdAt })).slice(offset, offset + 50),
        fog: [{ fogId: "active", note: "真实运行截图是否可行", status: "ACTIVE" }, { fogId: "promoted", note: "补齐配图资产", status: "GRADUATED", graduatedPathId: "map-path-1" }].slice(offset, offset + 50),
      },
    } }); });
    const map = window.getByRole("region", { name: "目标路线图" });
    await expect(map).toBeVisible();
    await expect(map.getByRole("button", { name: "展开路线图" })).toHaveAttribute("aria-expanded", "false");
    await expect(map.getByRole("button", { name: /独立复核/u })).toHaveCount(0);
    await window.locator(".joi-goal-drawer-body").evaluate(element => { element.scrollTop = 0; });
    const title = window.getByRole("button", { name: "长任务执行记录", exact: true });
    await title.hover({ position: { x: 20, y: 5 } });
    const tooltip = window.getByRole("tooltip");
    await expect(tooltip).toContainText("最后一条要求");
    const firstTooltipTop = (await tooltip.boundingBox())?.y;
    await title.hover({ position: { x: 60, y: 15 } });
    await expect.poll(async () => (await tooltip.boundingBox())?.y).not.toBe(firstTooltipTop);
    expect(await tooltip.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await tooltip.hover();
    await expect(tooltip).toBeVisible();
    await window.screenshot({ animations: "disabled", path: path.resolve("test-results/e2e-goal-title-preview.png") });
    const textBox = await tooltip.boundingBox();
    if (textBox === null) throw new Error("Full title box is missing");
    await window.mouse.move(textBox.x + 20, textBox.y + 25);
    await window.mouse.down();
    await window.mouse.move(textBox.x + textBox.width + 8, textBox.y + 60);
    await window.mouse.up();
    await window.waitForTimeout(220);
    await expect(tooltip).toBeVisible();
    expect(await window.evaluate(() => (document.getSelection()?.toString().length ?? 0) > 0)).toBe(true);
    await window.evaluate(() => document.getSelection()?.removeAllRanges());
    await title.click({ button: "right", position: { x: 40, y: 10 } });
    const titleBox = await title.boundingBox();
    const menuBox = await window.getByRole("menu").boundingBox();
    expect(Math.abs((menuBox?.x ?? 0) - (titleBox?.x ?? 0) - 40)).toBeLessThan(2);
    await window.screenshot({ animations: "disabled", path: path.resolve("test-results/e2e-goal-title-menu.png") });
    await window.getByRole("menuitem", { name: "复制全文" }).press("Escape");
    await expect(window.getByRole("dialog")).toBeVisible();
    await window.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text: string) => { Reflect.set(window, "testCopiedGoalTitle", text); return Promise.resolve(); } } });
    });
    await title.click({ button: "right" });
    await window.getByRole("menuitem", { name: "复制全文" }).click();
    await expect(window.getByText("已复制全文", { exact: true })).toBeVisible();
    expect(await window.evaluate(() => Reflect.get(window, "testCopiedGoalTitle") as string)).toBe(fullGoalTitle);
    await map.getByRole("button", { name: "展开路线图" }).click();
    const failedPath = map.getByRole("button", { name: /独立复核/u });
    await failedPath.click();
    await expect(failedPath).toContainText("已关闭");
    await expect(failedPath).toContainText("任务失败");
    await expect(map.getByRole("region", { name: "路径详情" })).toContainText("复核异常需要单独展示");
    await map.getByRole("button", { name: /雾区/u }).click();
    await map.getByRole("button", { name: "查看晋升路径" }).click();
    await expect(map.getByRole("button", { name: /配图资产/u })).toHaveAttribute("aria-pressed", "true");
    await expectNoHorizontalOverflow(window);
    await window.locator(".joi-goal-drawer-body").evaluate(element => { element.scrollTop = 0; });
    await window.screenshot({ animations: "disabled", path: path.resolve("test-results/e2e-goal-route-map.png") });
    await window.setViewportSize({ height: 900, width: 480 });
    const historicalNodes = map.locator(".joi-route-layer").first().locator(".joi-route-nodes");
    expect(await historicalNodes.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(1);
    const narrowMap = await map.evaluate(element => ({ right: element.getBoundingClientRect().right, client: element.clientWidth, scroll: element.scrollWidth }));
    expect(narrowMap.right).toBeLessThanOrEqual(480);
    expect(narrowMap.scroll).toBeLessThanOrEqual(narrowMap.client);
    await window.screenshot({ animations: "disabled", path: path.resolve("test-results/e2e-goal-route-map-480.png") });
    await window.setViewportSize({ height: 900, width: 768 });
    largeMap = true;
    await expect(map.getByText("167 条路径 · 32 项决策 · 2 项雾区")).toBeVisible();
    await map.getByRole("button", { name: "收起路线图" }).click();
    for (const width of [480, 768, 1280]) {
      await window.setViewportSize({ height: 900, width });
      await window.locator(".joi-goal-drawer-body").evaluate(element => { element.scrollTop = 0; });
      const overview = await map.boundingBox();
      expect(overview?.height).toBeLessThan(240);
      expect((overview?.x ?? 0) + (overview?.width ?? 0)).toBeLessThanOrEqual(width);
      await expect(map.getByRole("button", { name: /独立复核/u })).toHaveCount(0);
      await title.dispatchEvent("contextmenu", { button: 2, clientX: width - 2, clientY: 898 });
      const edgeMenu = await window.getByRole("menu").boundingBox();
      if (edgeMenu === null) throw new Error("Title menu is missing");
      expect(edgeMenu.x).toBeGreaterThanOrEqual(12);
      expect(edgeMenu.y).toBeGreaterThanOrEqual(12);
      expect(edgeMenu.x + edgeMenu.width).toBeLessThanOrEqual(width - 12);
      expect(edgeMenu.y + edgeMenu.height).toBeLessThanOrEqual(888);
      const copyItem = window.getByRole("menuitem", { name: "复制全文" });
      expect(await copyItem.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("[role=menuitem]") === element;
      })).toBe(true);
      await copyItem.press("Escape");
      await window.screenshot({ animations: "disabled", path: path.resolve(`test-results/e2e-goal-overview-${String(width)}.png`) });
    }
    await map.getByRole("button", { name: "展开路线图" }).click();
    await expect(map.getByText("已加载 50 / 共 167 项")).toBeVisible();
    await map.getByRole("button", { name: "加载更多路径、决策与雾区" }).click();
    await expect(map.getByText("已加载 100 / 共 167 项")).toBeVisible();
    const mapScroll = map.getByRole("region", { name: "路线图详情" });
    const scrollTop = await mapScroll.evaluate(element => { element.scrollTop = 140; return element.scrollTop; });
    expect(scrollTop).toBeGreaterThan(0);
    await map.getByRole("button", { name: "收起路线图" }).click();
    await map.getByRole("button", { name: "展开路线图" }).click();
    expect(await mapScroll.evaluate(element => element.scrollTop)).toBe(scrollTop);
    await map.getByRole("button", { name: /^决策/u }).click();
    await expect(map.getByText("已加载 32 / 共 32 项")).toBeVisible();
    expect(await mapScroll.evaluate(element => element.scrollTop)).toBe(0);
    await mapScroll.evaluate(element => { element.scrollTop = 120; element.dispatchEvent(new Event("scroll")); });
    await map.getByRole("button", { name: /^路径/u }).click();
    expect(await mapScroll.evaluate(element => element.scrollTop)).toBe(scrollTop);
    await map.getByRole("button", { name: /^决策/u }).click();
    expect(await mapScroll.evaluate(element => element.scrollTop)).toBe(120);
    await mapScroll.evaluate(element => { element.scrollTop = 0; });
    await window.locator(".joi-goal-drawer-body").evaluate(element => { element.scrollTop = 0; });
    await window.screenshot({ animations: "disabled", path: path.resolve("test-results/e2e-goal-map-details.png") });
    await window.setViewportSize({ height: 900, width: 768 });
    await window.getByRole("button", { name: "关闭", exact: true }).click();
    await window.getByRole("button", { exact: true, name: "工作台" }).click();
    await window.getByRole("button", { name: "打开工作台 栖光" }).click();
    await expectNoHorizontalOverflow(window);
    await mkdir(path.resolve("test-results"), { recursive: true });
    await window.screenshot({ path: path.resolve("test-results/e2e-console-768.png") });
    await window.getByRole("button", { name: "移除工作台", exact: true }).click();
    await expect(window.getByRole("dialog")).toContainText("历史记录和工作目录会保留");
    await window.screenshot({ path: path.resolve("test-results/e2e-workbench-removal-768.png") });
    await window.getByRole("button", { name: "取消", exact: true }).click();
    await expect(window.getByRole("heading", { name: "栖光", exact: true })).toBeVisible();
    await window.getByRole("button", { name: "移除工作台", exact: true }).click();
    await window.getByRole("button", { name: "确认移除", exact: true }).click();
    await expect(window.getByRole("dialog")).toHaveCount(0);
    await expect(window.getByRole("heading", { name: "工作台", exact: true })).toBeVisible();
    await expect(window.getByRole("button", { name: /栖光/u })).toHaveCount(0);
  } finally {
    await application.close();
    await rm(skillsRoot, { recursive: true, force: true });
  }
});
