import type { Page } from "@playwright/test";

/** Existing scenarios choose their fixture language independently of the host OS. */
export async function setDesktopTestLocale(page: Page, uiLocale: "en" | "zh-CN"): Promise<void> {
  await page.evaluate(async (locale) => {
    const bridge = window.digitalLifeDesktop;
    if (bridge === undefined) throw new Error("Expected the disposable desktop bridge");
    const info = await bridge.getRuntimeInfo();
    const bootstrap = await bridge.createBootstrapNonce();
    const response = await fetch(`${info.apiOrigin}/api/v1/auth/bootstrap`, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: bootstrap.nonce }) });
    if (!response.ok) throw new Error("Could not bootstrap the disposable test session");
    const grant = await response.json() as { csrfToken: string };
    const saved = await fetch(`${info.apiOrigin}/api/v1/settings`, { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": grant.csrfToken }, body: JSON.stringify({ uiLocale: locale }) });
    if (!saved.ok) throw new Error("Could not set the test locale");
  }, uiLocale);
  await page.reload();
}
