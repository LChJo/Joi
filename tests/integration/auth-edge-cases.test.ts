import { createRuntimeFixture } from "../support/runtime-fixture";

async function configuredFixture() {
  const fixture = await createRuntimeFixture();
  const bootstrap = await fixture.auth.issueDesktopBootstrap();
  const desktop = await fixture.auth.exchangeDesktopBootstrap({ nonce: bootstrap.nonce, remoteAddress: "127.0.0.1" });
  await fixture.auth.setupPassword({
    csrfToken: desktop.csrfToken,
    origin: "null",
    password: "correct horse battery staple",
    remoteAddress: "127.0.0.1",
    sessionToken: desktop.sessionToken,
  });
  return { desktop, fixture };
}

describe("administrator authentication edge cases", () => {
  it("expires bootstrap nonces and restricts them to loopback", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const remote = await fixture.auth.issueDesktopBootstrap();
      await expect(fixture.auth.exchangeDesktopBootstrap({ nonce: remote.nonce, remoteAddress: "192.168.1.10" }))
        .rejects.toMatchObject({ code: "bootstrap_invalid" });
      const expired = await fixture.auth.issueDesktopBootstrap();
      fixture.clock.advance(60_001);
      await expect(fixture.auth.exchangeDesktopBootstrap({ nonce: expired.nonce, remoteAddress: "::1" }))
        .rejects.toMatchObject({ code: "bootstrap_invalid" });
    } finally {
      await fixture.close();
    }
  });

  it("enforces initial setup rules and LAN-only login origin", async () => {
    const fixture = await createRuntimeFixture();
    try {
      expect(await fixture.auth.isConfigured()).toBe(false);
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const desktop = await fixture.auth.exchangeDesktopBootstrap({ nonce: bootstrap.nonce, remoteAddress: "::ffff:127.0.0.1" });
      await expect(fixture.auth.setupPassword({
        csrfToken: desktop.csrfToken, origin: "null", password: "short", remoteAddress: "127.0.0.1", sessionToken: desktop.sessionToken,
      })).rejects.toMatchObject({ code: "password_too_short" });
      await fixture.auth.setupPassword({
        csrfToken: desktop.csrfToken, origin: "null", password: "sixsix", remoteAddress: "127.0.0.1", sessionToken: desktop.sessionToken,
      });
      expect(await fixture.auth.isConfigured()).toBe(true);
      await expect(fixture.auth.setupPassword({
        csrfToken: desktop.csrfToken, origin: "null", password: "another secure password", remoteAddress: "127.0.0.1", sessionToken: desktop.sessionToken,
      })).rejects.toMatchObject({ code: "admin_already_configured" });
      await expect(fixture.auth.login({
        expectedOrigin: "http://192.168.1.10:43130", origin: "http://malicious.invalid", password: "sixsix", remoteAddress: "192.168.1.50",
      })).rejects.toMatchObject({ code: "origin_invalid" });

      const lan = await fixture.auth.login({
        expectedOrigin: "http://192.168.1.10:43130", origin: "http://192.168.1.10:43130", password: "sixsix", remoteAddress: "192.168.1.50",
      });
      await expect(fixture.auth.setupPassword({
        csrfToken: lan.csrfToken, origin: "null", password: "another secure password", remoteAddress: "192.168.1.50", sessionToken: lan.sessionToken,
      })).rejects.toMatchObject({ code: "desktop_required" });
    } finally {
      await fixture.close();
    }
  });

  it("revokes sessions and rejects missing or expired sessions", async () => {
    const { desktop, fixture } = await configuredFixture();
    try {
      await expect(fixture.auth.authenticate("missing-session")).rejects.toMatchObject({ code: "session_invalid" });
      const lan = await fixture.auth.login({
        expectedOrigin: "http://192.168.1.10:43130", origin: "http://192.168.1.10:43130", password: "correct horse battery staple", remoteAddress: "192.168.1.50",
      });
      await fixture.auth.logout(lan.sessionToken);
      await expect(fixture.auth.authenticate(lan.sessionToken)).rejects.toMatchObject({ code: "session_invalid" });
      fixture.clock.advance(24 * 60 * 60 * 1000 + 1);
      await expect(fixture.auth.authenticate(desktop.sessionToken)).rejects.toMatchObject({ code: "session_invalid" });
    } finally {
      await fixture.close();
    }
  });

  it("lists redacted sessions and revokes LAN access when the password changes", async () => {
    const { desktop, fixture } = await configuredFixture();
    try {
      const lan = await fixture.auth.login({
        expectedOrigin: "http://192.168.1.10:43130", origin: "http://192.168.1.10:43130", password: "correct horse battery staple", remoteAddress: "192.168.1.50",
      });
      const sessions = await fixture.auth.listSessions(desktop.sessionToken);
      expect(sessions).toHaveLength(2);
      expect(sessions).toEqual(expect.arrayContaining([expect.objectContaining({ current: true, kind: "desktop" }), expect.objectContaining({ kind: "lan" })]));
      expect(JSON.stringify(sessions)).not.toContain("192.168.1.50");
      await expect(fixture.auth.changePassword({
        csrfToken: desktop.csrfToken, currentPassword: "wrong password", expectedOrigin: "http://127.0.0.1:43130", newPassword: "a different secure password", origin: "null", remoteAddress: "127.0.0.1", sessionToken: desktop.sessionToken,
      })).rejects.toMatchObject({ code: "password_invalid" });
      await expect(fixture.auth.changePassword({
        csrfToken: desktop.csrfToken, currentPassword: "correct horse battery staple", expectedOrigin: "http://127.0.0.1:43130", newPassword: "short", origin: "null", remoteAddress: "127.0.0.1", sessionToken: desktop.sessionToken,
      })).rejects.toMatchObject({ code: "password_too_short" });
      await fixture.auth.changePassword({
        csrfToken: desktop.csrfToken, currentPassword: "correct horse battery staple", expectedOrigin: "http://127.0.0.1:43130", newPassword: "newpwd", origin: "null", remoteAddress: "127.0.0.1", sessionToken: desktop.sessionToken,
      });
      await expect(fixture.auth.authenticate(lan.sessionToken)).rejects.toMatchObject({ code: "session_invalid" });
      await expect(fixture.auth.login({
        expectedOrigin: "http://192.168.1.10:43130", origin: "http://192.168.1.10:43130", password: "correct horse battery staple", remoteAddress: "192.168.1.51",
      })).rejects.toMatchObject({ code: "login_invalid" });
      await expect(fixture.auth.login({
        expectedOrigin: "http://192.168.1.10:43130", origin: "http://192.168.1.10:43130", password: "newpwd", remoteAddress: "192.168.1.51",
      })).resolves.toMatchObject({ kind: "lan" });
    } finally {
      await fixture.close();
    }
  });
});
