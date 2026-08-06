import { _electron as electron, expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
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

test("Electron completes setup, native workbench creation, and responsive joi-console paths", async () => {
  test.setTimeout(60_000);
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });

  try {
    const window = await application.firstWindow();
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

    await window.setViewportSize({ height: 760, width: 960 });
    await window.getByRole("button", { exact: true, name: "设置" }).click();
    const modelSource = window.locator(".model-source-item").filter({ hasText: "DeepSeek E2E" });
    await expect(modelSource).toBeVisible();
    expect(await modelSource.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(600);
    await expectNoHorizontalOverflow(window);
    await mkdir(path.resolve("test-results"), { recursive: true });
    await window.screenshot({ path: path.resolve("test-results/e2e-model-source-960.png") });

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
    await window.getByRole("button", { name: /栖光/u }).click();
    await expect(window.getByRole("heading", { name: "栖光" })).toBeVisible();
    await expect(window.getByRole("tab", { name: /Agent/u })).toHaveAttribute("aria-selected", "true");
    await expect(window.getByRole("heading", { name: "还没有 Agent" })).toBeVisible();
    await expectNoHorizontalOverflow(window);
    await mkdir(path.resolve("test-results"), { recursive: true });
    await window.screenshot({ path: path.resolve("test-results/e2e-console-768.png") });
  } finally {
    await application.close();
  }
});
