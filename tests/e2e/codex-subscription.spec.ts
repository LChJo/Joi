import { _electron as electron, expect, test } from "@playwright/test";
import { setDesktopTestLocale } from "./locale";

test("opens the Codex authorization link in the system browser", async () => {
  test.setTimeout(60_000);
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    await application.evaluate(({ shell }) => {
      shell.openExternal = (url) => {
        (globalThis as typeof globalThis & { openedCodexUrl?: string }).openedCodexUrl = url;
        return Promise.resolve();
      };
    });
    const window = await application.firstWindow();
    await setDesktopTestLocale(window, "zh-CN");
    await window.getByLabel("管理密码").fill("correct horse battery staple");
    await window.getByLabel("确认密码").fill("correct horse battery staple");
    await window.getByRole("button", { name: /保存并继续/ }).click();
    await window.getByRole("button", { name: /先只用本机/ }).click();
    await window.getByRole("button", { name: "暂时跳过" }).click();
    await window.getByRole("button", { exact: true, name: "设置" }).click();
    await window.getByRole("button", { name: "添加网络" }).click();

    const url = "https://auth.openai.com/oauth/authorize?state=synthetic-state";
    await window.route("**/api/v1/model-sources/codex-login", async (route) => {
      expect(route.request().postDataJSON()).toEqual({ method: "browser" });
      await route.fulfill({ status: 202, json: { attemptId: "browser-attempt", status: "browser", url, acceptsCallback: true } });
    });
    await window.route("**/api/v1/model-sources/codex-login/browser-attempt", async (route) => {
      if (route.request().method() === "DELETE") await route.fulfill({ status: 204 });
      else await route.fulfill({ json: { attemptId: "browser-attempt", status: "browser", url, acceptsCallback: true } });
    });
    await window.getByRole("button", { name: "连接 Codex 订阅" }).click();
    await window.getByRole("button", { name: "使用 ChatGPT 登录" }).click();
    await window.getByRole("link", { name: "在浏览器中打开授权页" }).click();
    await expect.poll(() => application.evaluate(() => (
      globalThis as typeof globalThis & { openedCodexUrl?: string }
    ).openedCodexUrl)).toBe(url);
    expect(application.windows()).toHaveLength(1);
    await window.getByRole("button", { name: "取消", exact: true }).click();
    await expect(window.getByRole("link", { name: "在浏览器中打开授权页" })).toHaveCount(0);
  } finally {
    await application.close();
  }
});
