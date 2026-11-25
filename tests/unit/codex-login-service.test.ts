import { CodexLoginService, SubscriptionLoginService } from "../../src/main/application/model-sources/codex-login-service.js";
import { SubscriptionLoginDiagnostics } from "../../src/main/application/model-sources/subscription-login-diagnostics.js";
import type { CodexAuthorizationPort } from "../../src/main/application/ports/model-source-ports.js";
import type { ModelSourceService } from "../../src/main/application/model-sources/model-source-service.js";
import { isCodexAuthorizationUrl } from "../../src/shared/codex-authorization.js";
import type { ModelSourceDto } from "../../src/shared/joi.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const owner = "desktop-session";
const browserUrl = "https://auth.openai.com/oauth/authorize?state=fixture-state";
const deviceUrl = "https://auth.openai.com/codex/device";
const callbackUrl = "http://localhost:1455/auth/callback?code=fixture-code&state=fixture-state";

function loginFixture() {
  const authorize = vi.fn<CodexAuthorizationPort["authorize"]>();
  const connectCodex = vi.fn<ModelSourceService["connectCodex"]>();
  const service = new CodexLoginService({ authorization: { authorize }, ids: new TestIds(), sources: { connectCodex } });
  return { authorize, connectCodex, service };
}

describe("Codex login session ownership and lifetime", () => {
  it("reuses the same attempt for a duplicate request and isolates competing requests", async () => {
    const { authorize, service } = loginFixture();
    authorize.mockImplementation((input) => {
      input.showBrowser(browserUrl);
      return input.waitForCallback(input.signal).then(() => { throw new Error("synthetic exchange failure"); });
    });

    const attempt = service.start(owner, "browser", "source-a");
    try {
      expect(attempt).toMatchObject({ status: "browser", acceptsCallback: true });
      expect(service.start(owner, "browser", "source-a")).toEqual(attempt);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(() => service.start("different-session", "browser", "source-a")).toThrow(
        expect.objectContaining({ code: "codex_login_busy" }),
      );
      expect(() => service.start(owner, "device_code", "source-a")).toThrow(
        expect.objectContaining({ code: "codex_login_busy" }),
      );
      expect(() => service.start(owner, "browser", "source-b")).toThrow(
        expect.objectContaining({ code: "codex_login_busy" }),
      );
      expect(() => service.status(owner, "different-attempt")).toThrow(
        expect.objectContaining({ code: "codex_login_not_found" }),
      );
      expect(() => service.cancel("different-session", attempt.attemptId)).toThrow(
        expect.objectContaining({ code: "codex_login_not_found" }),
      );
      service.cancel(owner, attempt.attemptId);
      expect(service.status(owner, attempt.attemptId)).toEqual({ attemptId: attempt.attemptId, status: "canceled" });
      expect(() => service.start(owner, "browser", "source-a")).toThrow(
        expect.objectContaining({ code: "codex_login_busy" }),
      );
    } finally {
      await service.close();
    }
    expect(() => service.start(owner, "browser")).toThrow(expect.objectContaining({ code: "codex_login_unavailable" }));
  });

  it("accepts only the complete loopback redirect for the current browser attempt", async () => {
    const { authorize, connectCodex, service } = loginFixture();
    const exchanged = vi.fn(() => { throw new Error("synthetic exchange failure"); });
    authorize.mockImplementation((input) => {
      input.showBrowser(browserUrl);
      return input.waitForCallback(input.signal).then(exchanged);
    });
    const { attemptId } = service.start(owner, "browser");
    const invalidCallbacks = [
      "fixture-code",
      callbackUrl.replace("localhost", "127.0.0.1"),
      callbackUrl.replace(":1455", ":1456"),
      callbackUrl.replace("/auth/callback", "/auth/other"),
      callbackUrl.replace("localhost", "fixture-user@localhost"),
      callbackUrl.replace("localhost", ":fixture-password@localhost"),
      callbackUrl + "#fragment",
      callbackUrl + "&code=duplicate",
      callbackUrl.replace("fixture-code", ""),
      callbackUrl + "&state=duplicate",
      callbackUrl.replace("fixture-state", "another-attempt"),
    ];
    try {
      for (const invalid of invalidCallbacks) {
        expect(() => service.submitCallback(owner, attemptId, invalid)).toThrow(
          expect.objectContaining({ code: "codex_callback_invalid" }),
        );
      }
      expect(exchanged).not.toHaveBeenCalled();
      expect(service.status(owner, attemptId)).toMatchObject({ status: "browser", acceptsCallback: true });
      service.submitCallback(owner, attemptId, callbackUrl);
      expect(() => service.submitCallback(owner, attemptId, callbackUrl)).toThrow(
        expect.objectContaining({ code: "codex_callback_unavailable" }),
      );
      await vi.waitFor(() => expect(service.status(owner, attemptId)).toEqual({ attemptId, status: "failed" }));
      expect(exchanged).toHaveBeenCalledExactlyOnceWith(callbackUrl);
      expect(connectCodex).not.toHaveBeenCalled();
    } finally {
      await service.close();
    }
  });

  it("expires an outstanding device grant and ignores authorization updates after expiry", async () => {
    vi.useFakeTimers();
    const { authorize, connectCodex, service } = loginFixture();
    authorize.mockImplementation((input) => {
      input.showDeviceCode(deviceUrl, "FIXTURE-CODE");
      return new Promise((_, reject) => {
        input.signal.addEventListener("abort", () => {
          input.showBrowser(browserUrl);
          input.showDeviceCode(deviceUrl, "LATE-CODE");
          reject(new Error("synthetic canceled device grant"));
        }, { once: true });
      });
    });
    try {
      const { attemptId } = service.start(owner, "device_code");
      expect(service.status(owner, attemptId)).toMatchObject({ status: "device_code", userCode: "FIXTURE-CODE" });
      expect(() => service.submitCallback(owner, attemptId, callbackUrl)).toThrow(
        expect.objectContaining({ code: "codex_callback_unavailable" }),
      );
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      service.cancel(owner, attemptId);
      expect(service.status(owner, attemptId)).toEqual({ attemptId, status: "expired" });
      expect(connectCodex).not.toHaveBeenCalled();
    } finally {
      await service.close();
      vi.useRealTimers();
    }
  });

  it("rejects a callback prompt when the authorization port has not opened the browser", async () => {
    const { authorize, service } = loginFixture();
    authorize.mockImplementation(async (input) => {
      await expect(input.waitForCallback(input.signal)).rejects.toThrow("codex_callback_canceled");
      throw new Error("synthetic exchange failure");
    });
    const attempt = service.start(owner, "browser");
    expect(attempt.status).toBe("starting");
    await vi.waitFor(() => expect(service.status(owner, attempt.attemptId).status).toBe("failed"));
    await service.close();
  });
});

describe("Antigravity sign-in diagnostics", () => {
  function antigravityFixture(authorize: CodexAuthorizationPort["authorize"]) {
    const diagnostics = new SubscriptionLoginDiagnostics(new TestClock());
    const source: ModelSourceDto = {
      accessMode: "coding-plan",
      activeModel: { capability: "release-tested", id: "gemini-3.8-flash", revisionId: "model-1" },
      activeSourceRevisionId: "source-revision-1",
      credential: { configured: true, version: 1 },
      displayName: "Antigravity",
      kind: "antigravity",
      order: 0,
      primary: true,
      protocol: "google",
      sourceId: "ag-source",
      status: "READY",
    };
    const connect = vi.fn<ModelSourceService["connectCodex"]>().mockResolvedValue(source);
    const service = new SubscriptionLoginService({
      provider: "antigravity", authorization: { authorize }, ids: new TestIds(), diagnostics, connect,
    });
    return { connect, diagnostics, service };
  }

  it("records sanitized stages and a bounded failure reason without credentials", async () => {
    const { diagnostics, service } = antigravityFixture(async (input) => {
      input.showBrowser("https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state");
      input.onStage?.({ stage: "browser_open", outcome: "ok" });
      await input.waitForCallback(input.signal);
      input.onStage?.({ stage: "callback_received", outcome: "ok" });
      input.onStage?.({ stage: "token_exchange", outcome: "failed", reasonCode: "token_exchange_rejected" });
      throw new Error("401 OAuth credential rejected");
    });
    const attempt = service.start(owner, "browser");
    await vi.waitFor(() => expect(service.status(owner, attempt.attemptId)).toMatchObject({ status: "browser" }));
    service.submitCallback(owner, attempt.attemptId, "http://localhost:51121/oauth-callback?code=fixture-code&state=fixture-state");
    await vi.waitFor(() => expect(service.status(owner, attempt.attemptId)).toMatchObject({ status: "failed", reasonCode: "token_exchange_rejected" }));
    const dto = diagnostics.latest("antigravity");
    expect(dto).toMatchObject({ provider: "antigravity", outcome: "failed" });
    expect(dto?.stages.map((stage) => stage.stage)).toEqual(["browser_open", "callback_received", "token_exchange"]);
    expect(dto?.stages.at(-1)).toMatchObject({ stage: "token_exchange", outcome: "failed", reasonCode: "token_exchange_rejected" });
    expect(JSON.stringify(dto)).not.toMatch(/private-|fixture-state/u);
    await service.close();
  });

  it("finishes completed sign-ins with every stage and keeps the stored account out of diagnostics", async () => {
    const { connect, diagnostics, service } = antigravityFixture(async (input) => {
      input.showBrowser("https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state");
      input.onStage?.({ stage: "browser_open", outcome: "ok" });
      await input.waitForCallback(input.signal);
      input.onStage?.({ stage: "callback_received", outcome: "ok" });
      input.onFacts?.({ accountEmail: "brycen@gmail.com", clientSource: "builtin" });
      return { access: "private-access", refresh: "private-refresh", expires: Date.now() + 3600_000 };
    });
    const attempt = service.start(owner, "browser", "ag-source");
    await vi.waitFor(() => expect(service.status(owner, attempt.attemptId)).toMatchObject({ status: "browser" }));
    service.submitCallback(owner, attempt.attemptId, "http://localhost:51121/oauth-callback?code=fixture-code&state=fixture-state");
    await vi.waitFor(() => expect(service.status(owner, attempt.attemptId)).toMatchObject({ status: "completed" }));
    const dto = diagnostics.latest("antigravity");
    expect(dto?.stages.map((stage) => stage.stage)).toEqual(["browser_open", "callback_received", "credential_store"]);
    expect(dto).toMatchObject({ outcome: "completed", accountEmail: "b***@gmail.com", clientSource: "builtin" });
    expect(connect).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it("records a cancellation and a bounded reason when the attempt is aborted", async () => {
    const { diagnostics, service } = antigravityFixture((input) => new Promise((_resolve, reject) => {
      input.showBrowser("https://accounts.google.com/o/oauth2/v2/auth?state=fixture-state");
      input.onStage?.({ stage: "browser_open", outcome: "ok" });
      input.signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true });
    }));
    const attempt = service.start(owner, "browser");
    service.cancel(owner, attempt.attemptId);
    await vi.waitFor(() => expect(service.status(owner, attempt.attemptId)).toEqual({ attemptId: attempt.attemptId, status: "canceled" }));
    expect(diagnostics.latest("antigravity")).toMatchObject({ outcome: "canceled" });
    expect(diagnostics.latest("antigravity")?.stages.map((stage) => stage.stage)).toEqual(["browser_open"]);
    await service.close();
  });
});

describe("Codex authorization link allowlist", () => {
  it.each([
    "oauth/authorize",
    "http://auth.openai.com/oauth/authorize",
    "https://auth.openai.com.example.invalid/oauth/authorize",
    "https://fixture-user@auth.openai.com/oauth/authorize",
    "https://:fixture-password@auth.openai.com/oauth/authorize",
    "https://auth.openai.com/oauth/authorize#fragment",
    "https://auth.openai.com/codex/device?unexpected=true",
    "https://auth.openai.com/login",
  ])("rejects unapproved authorization link %s", (url) => {
    expect(isCodexAuthorizationUrl(url)).toBe(false);
  });

  it("accepts only the route for the requested authorization method", () => {
    expect(isCodexAuthorizationUrl(browserUrl, "browser")).toBe(true);
    expect(isCodexAuthorizationUrl(browserUrl, "device_code")).toBe(false);
    expect(isCodexAuthorizationUrl(deviceUrl, "device_code")).toBe(true);
    expect(isCodexAuthorizationUrl(deviceUrl, "browser")).toBe(false);
  });
});
