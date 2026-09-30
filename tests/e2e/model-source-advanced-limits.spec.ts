import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A source whose limits are not one of the tiers the form offers. That is the case the select has to
 * survive: it can only submit one of its own options, so opening this form and saving must not
 * rewrite a limit the user never touched — which is exactly how a route ends up configured above
 * what it accepts, and how every run on it then fails.
 */
function seedSizedSource(userDataDirectory: string): void {
  const database = new DatabaseSync(path.join(userDataDirectory, "runtime.sqlite"));
  const now = new Date().toISOString();
  try {
    database.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    database.prepare(`INSERT INTO model_source_credentials
      (provider_id, credential_type, encrypted_blob, credential_version, updated_at)
      VALUES ('joi-source:e2e-limits', 'api_key', ?, 1, ?)`).run(new Uint8Array([7, 8, 9]), now);
    database.prepare(`INSERT INTO model_sources
      (source_id, status, active_source_revision_id, active_model_revision_id, created_at, updated_at)
      VALUES ('e2e-limits', 'READY', NULL, NULL, ?, ?)`).run(now, now);
    database.prepare(`INSERT INTO model_source_revisions
      (source_revision_id, source_id, kind, access_mode, protocol, display_name, base_url, credential_ref, credential_version, created_at)
      VALUES ('source-revision-e2e-limits', 'e2e-limits', 'generic-openai', 'custom', 'anthropic', '127-glm',
        'http://127.0.0.1:54455/', 'joi-source:e2e-limits', 1, ?)`).run(now);
    database.prepare(`INSERT INTO model_source_model_revisions
      (model_revision_id, source_id, model_id, capability, preset_version, created_at, context_window, max_output_tokens, thinking_effort)
      VALUES ('model-revision-e2e-limits', 'e2e-limits', 'glm-5.3-flash', 'custom-unverified-tools', NULL, ?, 999424, 119040, 'max')`).run(now);
    database.prepare(`UPDATE model_sources
      SET active_source_revision_id = 'source-revision-e2e-limits', active_model_revision_id = 'model-revision-e2e-limits'
      WHERE source_id = 'e2e-limits'`).run();
    database.prepare(`INSERT INTO model_source_health
      (source_id, status, updated_at, last_validated_at) VALUES ('e2e-limits', 'READY', ?, ?)`).run(now, now);
    database.prepare("INSERT INTO model_source_order (source_id, position, is_primary) VALUES ('e2e-limits', 0, 1)").run();
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  } finally {
    database.close();
  }
}

test("the advanced limits are picked from tiers and a size outside them is kept", async () => {
  test.setTimeout(60_000);
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });

  try {
    const window = await application.firstWindow();
    await window.getByLabel("管理密码").fill("correct horse battery staple");
    await window.getByLabel("确认密码").fill("correct horse battery staple");
    await window.getByRole("button", { name: /保存并继续/ }).click();
    await window.getByRole("button", { name: /先只用本机/ }).click();
    await window.getByRole("button", { name: "暂时跳过" }).click();

    seedSizedSource(await application.evaluate(({ app }) => app.getPath("userData")));
    await window.reload();

    await window.setViewportSize({ height: 900, width: 1280 });
    await window.getByRole("button", { exact: true, name: "设置" }).click();
    const item = window.locator(".model-source-item").filter({ hasText: "127-glm" });
    await item.getByRole("button", { name: "编辑 127-glm" }).click();
    await item.locator("summary").click();

    const contextWindow = item.getByLabel("上下文窗口（tokens）");
    const maxOutput = item.getByLabel("最大输出（tokens）");
    const compaction = item.getByLabel("压缩阈值（窗口百分比）");
    // Every field is a select now, and the revision's own figure is offered back rather than lost.
    await expect(contextWindow).toHaveValue("999424");
    await expect(maxOutput).toHaveValue("119040");
    await expect(contextWindow.locator("option", { hasText: "1M" })).toHaveCount(1);
    await expect(contextWindow.locator("option", { hasText: "500K" })).toHaveCount(1);
    await expect(compaction).toHaveValue("");
    await mkdir(path.resolve("test-results"), { recursive: true });
    await item.locator(".model-source-advanced").scrollIntoViewIfNeeded();
    await item.locator(".model-source-advanced").screenshot({ path: path.resolve("test-results/e2e-model-source-limits.png") });

    // Picking a tier is what a select is for; the value it submits is the tier's own figure.
    await contextWindow.selectOption("1000000");
    await maxOutput.selectOption("131072");
    await compaction.selectOption("85");
    await item.getByRole("button", { name: "保存修改" }).click();
    await expect(window.getByText(/修改已保存为草稿 revision/)).toBeVisible();
  } finally {
    await application.close();
  }
});
