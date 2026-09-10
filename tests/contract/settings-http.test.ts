import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createApiHandler } from "../../src/main/interfaces/http/api-handler";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners";
import { SystemSettingsService } from "../../src/main/infrastructure/operations/system-settings-service";
import { createRuntimeFixture } from "../support/runtime-fixture";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

describe("LAN settings HTTP contract", () => {
  it("returns actionable validation codes and safe settings projections", async () => {
    const fixture = await createRuntimeFixture();
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-settings-http-"));
    const settings = new SystemSettingsService({
      getLaunchAtLogin: () => false,
      listLanAddresses: [{ address: "192.168.1.20", available: true }],
      setLaunchAtLogin: () => undefined,
      settingsPath: path.join(root, "settings.json"),
      validateJoiSkills: () => undefined,
    });
    const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, settings }), loopbackPort: 0 });
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const authenticated = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      const cookie = cookieFrom(authenticated);
      const { csrfToken } = await authenticated.json() as { csrfToken: string };
      const invalid = await fetch(`${listeners.loopback.url}/api/v1/settings`, {
        body: JSON.stringify({ lan: { address: "192.168.1.20", enabled: true, port: 43_130, riskAccepted: false } }),
        headers: { "content-type": "application/json", cookie, origin: listeners.loopback.url, "x-csrf-token": csrfToken },
        method: "POST",
      });
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get("cache-control")).toBe("no-store");
      expect(await invalid.json()).toMatchObject({ code: "lan_risk_required" });

      const read = await fetch(`${listeners.loopback.url}/api/v1/settings`, { headers: { cookie } });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ lan: { availableAddresses: [{ address: "192.168.1.20", available: true }], effective: { status: "disabled" } } });
      const postSkills = (joiSkills: unknown) => fetch(`${listeners.loopback.url}/api/v1/settings`, {
        body: JSON.stringify({ joiSkills }),
        headers: { "content-type": "application/json", cookie, origin: listeners.loopback.url, "x-csrf-token": csrfToken },
        method: "POST",
      });
      const saved = await postSkills(["agents/lark-project"]);
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ joiSkills: ["agents/lark-project"] });
      const invalidSkills = await postSkills("agents/lark-project");
      expect(invalidSkills.status).toBe(400);
      expect(await invalidSkills.json()).toMatchObject({ code: "joi_skills_invalid" });
      expect((await settings.get()).joiSkills).toEqual(["agents/lark-project"]);
      const cleared = await postSkills([]);
      expect(await cleared.json()).toMatchObject({ joiSkills: [] });
    } finally {
      await listeners.close();
      await fixture.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
