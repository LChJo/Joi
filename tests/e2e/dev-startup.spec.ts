import { _electron as electron, expect, test } from "@playwright/test";
import { createServer as createTcpServer } from "node:net";
import { createServer as createViteServer } from "vite";

async function freeLoopbackPort(): Promise<number> {
  const listener = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) => listener.close(error => error === undefined ? resolve() : reject(error)));
  if (address === null || typeof address === "string") throw new Error("Expected a loopback TCP port.");
  return address.port;
}

test("development window loads Vite, completes local setup and opens conversations", async () => {
  test.setTimeout(60_000);
  const apiPort = await freeLoopbackPort();
  const vite = await createViteServer({
    logLevel: "silent",
    server: { port: 0, proxy: { "/api": `http://127.0.0.1:${String(apiPort)}` } },
  });
  try {
    await vite.listen();
    const origin = vite.resolvedUrls?.local[0];
    if (origin === undefined) throw new Error("Expected a Vite loopback URL.");
    const app = await electron.launch({ args: ["."], env: { ...process.env, JOI_TEST: "1", JOI_DEV_API_PORT: String(apiPort), VITE_DEV_SERVER_URL: origin } });
    try {
      const page = await app.firstWindow();
      const pageErrors: string[] = [];
      page.on("pageerror", error => pageErrors.push(error.name));
      await expect(page.locator(".setup-layout")).toBeVisible({ timeout: 15_000 });
      expect(await page.evaluate(() => window.digitalLifeDesktop !== undefined)).toBe(true);
      const password = page.locator('.setup-stage input[type="password"]');
      await password.nth(0).fill("Synthetic dev startup password");
      await password.nth(1).fill("Synthetic dev startup password");
      await page.locator('.setup-stage button[type="submit"]').click();
      await page.locator(".setup-stage .button-row button").last().click();
      await page.locator(".setup-stage .button-row button").last().click();
      await expect(page.locator(".console-main")).toBeVisible();
      await page.locator(".sidebar nav button").filter({ hasText: /^(对话|Conversations)$/u }).click();
      await expect(page.locator(".chat-composer textarea")).toBeVisible();
      expect(pageErrors).toEqual([]);
    } finally { await app.close(); }
  } finally { await vite.close(); }
});
