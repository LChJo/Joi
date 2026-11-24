import { setDesktopTestLocale } from "./locale";
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

test("the advanced limits preserve custom sizes and a numeric Pi compaction threshold", async () => {
  test.setTimeout(60_000);
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });

  try {
    const window = await application.firstWindow();
    await setDesktopTestLocale(window, "zh-CN");
    await window.getByLabel("管理密码").fill("correct horse battery staple");
    await window.getByLabel("确认密码").fill("correct horse battery staple");
    await window.getByRole("button", { name: /保存并继续/ }).click();
    await window.getByRole("button", { name: /先只用本机/ }).click();
    await window.getByRole("button", { name: "暂时跳过" }).click();

    seedSizedSource(await application.evaluate(({ app }) => app.getPath("userData")));
    await window.reload();

    await window.setViewportSize({ height: 900, width: 1280 });
    await window.getByRole("button", { exact: true, name: "设置" }).click();
    await window.getByRole("button", { name: "添加网络" }).click();
    const choices = window.locator(".model-source-choices").getByRole("button");
    await expect(choices).toHaveCount(9);
    const heights = await choices.evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    expect(Math.max(...heights)).toBeLessThanOrEqual(48);
    await expect(choices.last()).toHaveText("连接 通用平台");
    await choices.last().click();
    await window.getByRole("button", { name: "OpenAI-compatible", exact: true }).click();
    const createForm = window.locator(".model-source-manager > .joi-network-gate .model-source-form");
    await createForm.locator("summary").click();
    await expect(createForm.getByLabel("上下文窗口（tokens）")).toHaveValue("1000000");
    await expect(createForm.getByLabel("最大输出（tokens）")).toHaveValue("131072");
    await createForm.getByRole("button", { name: "取消", exact: true }).click();
    await window.getByRole("button", { name: "收起", exact: true }).click();
    const item = window.locator(".model-source-item").filter({ hasText: "127-glm" });
    const more = item.getByRole("button", { name: "127-glm 更多操作" });
    await expect(item.getByRole("button", { name: "上移" })).toBeVisible();
    await expect(item.getByRole("button", { name: "下移" })).toBeVisible();
    await expect(item.getByRole("button", { name: "验证" })).toBeVisible();
    await expect(item.getByRole("button", { name: "编辑" })).toHaveCount(0);
    await more.click();
    await expect(item.getByRole("menuitem", { name: "删除" })).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(item.getByRole("menu")).toHaveCount(0);
    await more.click();
    await item.getByRole("menuitem", { name: "编辑" }).click();
    await item.locator("summary").click();

    const contextWindow = item.getByLabel("上下文窗口（tokens）");
    const maxOutput = item.getByLabel("最大输出（tokens）");
    const compaction = item.getByLabel("压缩阈值（窗口百分比）");
    // The token selectors retain the saved figures alongside the standard tiers.
    await expect(contextWindow).toHaveValue("999424");
    await expect(maxOutput).toHaveValue("119040");
    await expect(contextWindow.locator("option", { hasText: "1M" })).toHaveCount(1);
    await expect(contextWindow.locator("option", { hasText: "500K" })).toHaveCount(1);
    await expect(contextWindow.locator('option[value="2000000"]')).toHaveText("2M");
    await expect(contextWindow.locator('option[value="3000000"]')).toHaveText("3M");
    await expect(maxOutput.locator('option[value="262144"]')).toHaveText("256K");
    await expect(maxOutput.locator('option[value="307200"]')).toHaveText("300K");
    await expect(maxOutput.locator('option[value="524288"]')).toHaveText("512K");
    await expect(compaction).toHaveValue("");
    await mkdir(path.resolve("test-results"), { recursive: true });
    await item.locator(".model-source-advanced").scrollIntoViewIfNeeded();
    await item.locator(".model-source-advanced").screenshot({ path: path.resolve("test-results/e2e-model-source-limits.png") });

    await contextWindow.selectOption("3000000");
    await maxOutput.selectOption("524288");
    await compaction.fill("79");
    await window.route("**/api/v1/model-sources/*/validate", (route) => route.fulfill({ status: 503, json: { code: "fixture_unavailable", message: "Validation temporarily unavailable" } }));
    const validation = window.waitForRequest((request) => request.method() === "POST" && request.url().endsWith("/validate"));
    await item.getByRole("button", { name: "保存并验证" }).click();
    await validation;
    await expect(window.getByText(/修改已保存，自动验证未通过/)).toBeVisible();
    await window.setViewportSize({ height: 820, width: 420 });
    await expect(more).toBeVisible();
    await more.click();
    const menu = item.getByRole("menu");
    const bounds = await menu.boundingBox();
    expect(bounds).not.toBeNull();
    if (bounds !== null) {
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(420);
    }
    await window.keyboard.press("Escape");
    await window.setViewportSize({ height: 900, width: 1280 });
    await more.click();
    await item.getByRole("menuitem", { name: "编辑" }).click();
    await item.locator("summary").click();
    await expect(contextWindow).toHaveValue("3000000");
    await expect(maxOutput).toHaveValue("524288");
    await expect(compaction).toHaveValue("79");
  } finally {
    await application.close();
  }
});
