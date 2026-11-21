import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { createRuntimeFixture } from "../support/runtime-fixture";
import type { DesktopUpdateStatus } from "../../src/shared/desktop-update";

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (cookie === undefined) throw new Error("missing session cookie");
  return cookie;
}

describe("desktop update HTTP", () => {
  it("requires an authenticated desktop session and CSRF for version-scoped actions", async () => {
    const fixture = await createRuntimeFixture();
    const status: DesktopUpdateStatus = { currentVersion: "0.1.6", latestVersion: "0.1.7", mode: "restart", phase: "available" };
    const command = vi.fn().mockResolvedValue({ ...status, phase: "downloading" });
    const listeners = await startRuntimeListeners({
      handler: createApiHandler({ ...fixture, desktopUpdate: { status: () => status, command } }), loopbackPort: 0,
    });
    try {
      const base = listeners.loopback.url;
      const jsonHeaders = { "content-type": "application/json", origin: base };
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const desktop = await fetch(`${base}/api/v1/auth/bootstrap`, {
        method: "POST", headers: { ...jsonHeaders, origin: "null" }, body: JSON.stringify({ nonce: bootstrap.nonce }),
      });
      const cookie = sessionCookie(desktop);
      const { csrfToken } = await desktop.json() as { csrfToken: string };
      const headers = { ...jsonHeaders, cookie, "x-csrf-token": csrfToken };
      const post = (body: object, sentHeaders: Record<string, string> = headers) => fetch(`${base}/api/v1/desktop-update`, {
        method: "POST", headers: sentHeaders, body: JSON.stringify(body),
      });
      expect((await fetch(`${base}/api/v1/desktop-update`)).status).toBe(401);
      expect(await (await fetch(`${base}/api/v1/desktop-update`, { headers })).json()).toEqual(status);
      expect((await post({ action: "download", version: "0.1.7" }, { ...jsonHeaders, cookie })).status).toBe(403);
      expect((await post({ action: "download", version: "../../installer.exe" })).status).toBe(400);
      expect(command).not.toHaveBeenCalled();
      const start = await post({ action: "download", version: "0.1.7", downloadUrl: "https://invalid.example/" });
      expect(start.status).toBe(202);
      expect(await start.json()).toMatchObject({ phase: "downloading" });
      expect(command).toHaveBeenCalledExactlyOnceWith({ action: "download", version: "0.1.7" });

      await fetch(`${base}/api/v1/auth/setup`, { method: "POST", headers, body: JSON.stringify({ password: "disposable-ui-password" }) });
      const browser = await fetch(`${base}/api/v1/auth/login`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ password: "disposable-ui-password" }) });
      const browserCookie = sessionCookie(browser);
      const browserGrant = await browser.json() as { csrfToken: string };
      expect((await fetch(`${base}/api/v1/desktop-update`, { headers: { cookie: browserCookie } })).status).toBe(403);
      expect((await post({ action: "install", version: "0.1.7" }, { ...jsonHeaders, cookie: browserCookie, "x-csrf-token": browserGrant.csrfToken })).status).toBe(403);
      expect(command).toHaveBeenCalledOnce();
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
