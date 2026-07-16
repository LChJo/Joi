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

test("Electron completes setup, Life birth, and responsive shared-console paths", async () => {
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });

  try {
    const window = await application.firstWindow();
    await expect(window).toHaveTitle("joi");
    await expect(window.getByRole("heading", { name: "先守住进入这里的门。" })).toBeVisible();
    await window.getByLabel("管理员口令").fill("correct horse battery staple");
    await window.getByLabel("确认口令").fill("correct horse battery staple");
    await window.getByRole("button", { name: /保存并继续/ }).click();
    await window.getByRole("button", { name: /保持关闭并继续/ }).click();
    await window.getByRole("button", { name: "暂时跳过" }).click();
    await expect(window.getByRole("heading", { name: "你的数字生命" })).toBeVisible();
    const userDataDirectory = await application.evaluate(({ app }) => app.getPath("userData"));
    expect(userDataDirectory).toContain("joi-e2e");

    seedReadyAgent(userDataDirectory);
    await window.reload();
    await expect(window.getByRole("heading", { name: "你的数字生命" })).toBeVisible();
    await window.getByRole("button", { name: "Agents" }).click();
    await expect(window.getByText("Mana E2E")).toBeVisible();
    await window.getByRole("button", { exact: true, name: "生命" }).click();

    await window.setViewportSize({ height: 760, width: 960 });
    expect(await window.evaluate(() => globalThis.innerWidth)).toBe(960);
    await expectNoHorizontalOverflow(window);
    await window.getByRole("button", { name: "创建生命" }).click();
    await window.getByLabel("名称").fill("栖光");
    await window.getByLabel("人格摘要").fill("尊重事实，持续整理长期事务。");
    await window.getByLabel("初始目标（可选）").fill("建立第一份可追踪计划。");
    await window.getByRole("button", { name: /继续/ }).click();
    await expect(window.getByRole("radio", { name: /Mana E2E/ })).toBeChecked();
    await window.getByRole("button", { name: /继续/ }).click();
    await expect(window.getByText("计划一天")).toBeVisible();
    await window.getByRole("button", { name: /让它出生/ }).click();
    await expect(window.getByRole("navigation", { name: "生命详情" })).toBeVisible();
    await expectNoHorizontalOverflow(window);
    await expect(window.getByLabel("输入消息")).toBeVisible();
    await window.getByRole("button", { name: "事务与待办" }).click();
    await expect(window.getByRole("heading", { name: "待办" })).toBeVisible();
    await window.getByRole("button", { name: "作息与闹钟" }).click();
    await expect(window.getByRole("heading", { name: "作息" })).toBeVisible();

    await window.getByRole("button", { exact: true, name: "生命" }).click();
    await window.setViewportSize({ height: 900, width: 768 });
    expect(await window.evaluate(() => globalThis.innerWidth)).toBe(768);
    await expect(window.getByRole("heading", { name: "你的数字生命" })).toBeVisible();
    await expectNoHorizontalOverflow(window);
    await mkdir(path.resolve("test-results"), { recursive: true });
    await window.screenshot({ path: path.resolve("test-results/e2e-console-768.png") });
  } finally {
    await application.close();
  }
});
