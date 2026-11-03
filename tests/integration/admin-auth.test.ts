import { AuthError } from "../../src/main/application/auth/auth-service";
import { createRuntimeFixture } from "../support/runtime-fixture";

describe("single administrator authentication", () => {
  it("uses one-time desktop bootstrap, scrypt, persistent session and CSRF checks", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const grant = await fixture.auth.exchangeDesktopBootstrap({
        nonce: bootstrap.nonce,
        remoteAddress: "127.0.0.1",
      });
      await expect(fixture.auth.exchangeDesktopBootstrap({
        nonce: bootstrap.nonce,
        remoteAddress: "127.0.0.1",
      })).rejects.toMatchObject({ code: "bootstrap_invalid" });

      await fixture.auth.setupPassword({
        csrfToken: grant.csrfToken,
        origin: "null",
        password: "correct horse battery staple",
        remoteAddress: "127.0.0.1",
        sessionToken: grant.sessionToken,
      });
      const credential = await fixture.database.store.getAdminCredential();
      expect(credential?.algorithm).toBe("scrypt");
      expect(JSON.stringify(credential)).not.toContain("correct horse battery staple");

      const lanGrant = await fixture.auth.login({
        expectedOrigin: "http://192.168.1.10:43130",
        origin: "http://192.168.1.10:43130",
        password: "correct horse battery staple",
        remoteAddress: "192.168.1.50",
      });
      await expect(fixture.auth.verifyWrite({
        csrfToken: "wrong",
        expectedOrigin: "http://192.168.1.10:43130",
        origin: "http://192.168.1.10:43130",
        remoteAddress: "192.168.1.50",
        sessionToken: lanGrant.sessionToken,
      })).rejects.toMatchObject({ code: "csrf_invalid" });
      await expect(fixture.auth.verifyWrite({
        csrfToken: lanGrant.csrfToken,
        expectedOrigin: "http://192.168.1.10:43130",
        origin: "http://malicious.invalid",
        remoteAddress: "192.168.1.50",
        sessionToken: lanGrant.sessionToken,
      })).rejects.toMatchObject({ code: "origin_invalid" });
      await expect(fixture.auth.verifyWrite({
        csrfToken: lanGrant.csrfToken,
        expectedOrigin: "http://192.168.1.10:43130",
        origin: "http://192.168.1.10:43130",
        remoteAddress: "192.168.1.50",
        sessionToken: lanGrant.sessionToken,
      })).resolves.toMatchObject({ kind: "lan" });
    } finally {
      await fixture.close();
    }
  });

  it("rate limits repeated login failures by source", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const grant = await fixture.auth.exchangeDesktopBootstrap({ nonce: bootstrap.nonce, remoteAddress: "127.0.0.1" });
      await fixture.auth.setupPassword({
        csrfToken: grant.csrfToken,
        origin: "null",
        password: "correct horse battery staple",
        remoteAddress: "127.0.0.1",
        sessionToken: grant.sessionToken,
      });

      for (let index = 0; index < 10; index += 1) {
        await expect(fixture.auth.login({
          expectedOrigin: "http://192.168.1.10:43130",
          origin: "http://192.168.1.10:43130",
          password: "incorrect-password",
          remoteAddress: "192.168.1.77",
        })).rejects.toBeInstanceOf(AuthError);
      }
      await expect(fixture.auth.login({
        expectedOrigin: "http://192.168.1.10:43130",
        origin: "http://192.168.1.10:43130",
        password: "correct horse battery staple",
        remoteAddress: "192.168.1.77",
      })).rejects.toMatchObject({ code: "login_rate_limited" });
    } finally {
      await fixture.close();
    }
  });
});
