/* Synthetic fetch doubles resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { revokeAntigravityToken } from "../../src/main/infrastructure/pi/antigravity-revocation.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Antigravity token revocation", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the refresh token to the Google revoke endpoint and reports success", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(revokeAntigravityToken("synthetic-refresh-token")).resolves.toBe("revoked");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "token=synthetic-refresh-token",
      }),
    );
  });

  it("reports an already-invalid token without failing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: "invalid_token" })));
    await expect(revokeAntigravityToken("synthetic-refresh-token")).resolves.toBe("already_invalid");
  });

  it("keeps an unrecognizable 400 body bounded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(400, { error: "something else entirely" })));
    await expect(revokeAntigravityToken("synthetic-refresh-token")).resolves.toBe("failed");
  });

  it("collapses server failures and network errors into a bounded failed outcome", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "internal" })));
    await expect(revokeAntigravityToken("synthetic-refresh-token")).resolves.toBe("failed");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("synthetic connection refused"); }));
    await expect(revokeAntigravityToken("synthetic-refresh-token")).resolves.toBe("failed");
  });

  it("never retains the provider response body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("synthetic-private-revoke-body", { status: 403 })));
    await expect(revokeAntigravityToken("synthetic-refresh-token")).resolves.toBe("failed");
  });
});
