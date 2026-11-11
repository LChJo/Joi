import { _electron as electron, expect, test } from "@playwright/test";
import path from "node:path";

test("AC-I18N desktop and browser switch independently without resetting drafts", async () => {
  test.setTimeout(90_000);
  const application = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1" } });
  try {
    const page = await application.firstWindow();
    await page.locator(".language-selector select").first().selectOption("en");
    await expect(page.getByRole("heading", { name: "Set a password for joi first." })).toBeVisible();
    await page.getByLabel("Admin password", { exact: true }).fill("disposable-ui-test-password");
    await page.getByLabel("Confirm password", { exact: true }).fill("disposable-ui-test-password");
    await page.locator(".language-selector select").first().selectOption("zh-CN");
    await expect(page.getByLabel("管理密码", { exact: true })).toHaveValue("disposable-ui-test-password");
    await page.getByRole("button", { name: /保存并继续/ }).click();
    await page.getByRole("button", { name: /先只用本机/ }).click();
    await page.getByRole("button", { name: "暂时跳过", exact: true }).click();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
    for (const locale of ["en", "zh-CN"] as const) {
      await page.locator(".language-selector select").selectOption(locale);
      await expect.poll(() => page.evaluate(async () => (await window.digitalLifeDesktop?.getRuntimeInfo())?.uiLocale)).toBe(locale);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const width of [1280, 960, 768]) {
          await page.setViewportSize({ width, height: 800 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
          const [header,heading,language,tabs] = await page.evaluate(() => [".settings-page-header",".settings-page-heading",".settings-page-header .language-selector",'[role="tablist"]'].map(selector => {
            const element = document.querySelector(selector);if (element === null) return null;
            const rect = element.getBoundingClientRect();return { x: rect.x,y: rect.y,width: rect.width,height: rect.height };
          }));
          if (!header || !heading || !language || !tabs) throw new Error("Settings header controls must be visible");
          expect(language.x + language.width).toBeLessThanOrEqual(header.x + header.width + 1);
          expect(language.y + language.height).toBeLessThanOrEqual(tabs.y);
          if (width >= 768) expect(language.x).toBeGreaterThanOrEqual(heading.x + heading.width);
          if (width === 1280) await page.screenshot({ path: path.resolve(`test-results/i18n-desktop-${locale}-${colorScheme}.png`) });
          if (width === 768) await page.screenshot({ path: path.resolve(`test-results/i18n-settings-narrow-${locale}-${colorScheme}.png`) });
        }
      }
      if (locale === "en") expect((await page.locator("body").innerText()).replaceAll("简体中文", "")).not.toMatch(/[\p{Script=Han}]/u);
    }
    await page.reload();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.locator(".language-selector select")).toHaveValue("zh-CN");
    const url = await page.evaluate(async () => (await window.digitalLifeDesktop?.getRuntimeInfo())?.apiOrigin);
    const browserWindow = application.waitForEvent("window");
    await application.evaluate(async ({ BrowserWindow }, origin) => {
      const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, partition: "i18n-browser-test" } });
      await window.loadURL(origin ?? "about:blank");
    }, url);
    const browser = await browserWindow;
    await browser.locator(".language-selector select").selectOption("en");
    await expect(browser.getByRole("heading", { name: "Confirm it is you" })).toBeVisible();
    await browser.reload();
    await expect(browser.locator(".language-selector select")).toHaveValue("en");
    expect(await page.evaluate(async () => (await window.digitalLifeDesktop?.getRuntimeInfo())?.uiLocale)).toBe("zh-CN");
  } finally { await application.close(); }
});
