const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const REVOKE_TIMEOUT_MS = 5_000;

export type AntigravityRevocationOutcome = "revoked" | "already_invalid" | "failed" | "skipped";

/**
 * Best-effort Google-side revocation of a refresh token; revoking the refresh token invalidates
 * every access token derived from it. The outcome is a bounded fact — the response body is never
 * retained — and a failure never propagates to the caller's main flow.
 */
export async function revokeAntigravityToken(token: string, signal?: AbortSignal): Promise<Exclude<AntigravityRevocationOutcome, "skipped">> {
  const timeout = AbortSignal.timeout(REVOKE_TIMEOUT_MS);
  try {
    const response = await fetch(REVOKE_URL, { method: "POST", redirect: "error",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString() });
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return "revoked";
    }
    if (response.status === 400) {
      const data = await response.json().catch(() => null) as { error?: unknown } | null;
      await response.body?.cancel().catch(() => undefined);
      return data?.error === "invalid_token" ? "already_invalid" : "failed";
    }
    await response.body?.cancel().catch(() => undefined);
    return "failed";
  } catch {
    return "failed";
  }
}
