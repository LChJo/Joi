const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/u;

/**
 * Best-effort account identity for diagnostics and lifecycle views. Any failure yields an empty
 * result: sign-in must not depend on this endpoint being reachable, and the raw email only ever
 * travels inside the encrypted credential blob.
 */
export async function fetchAntigravityAccount(accessToken: string, signal: AbortSignal): Promise<{ email?: string }> {
  try {
    const response = await fetch(USERINFO_URL, { method: "GET", redirect: "error", signal,
      headers: { authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return {};
    }
    const data = await response.json().catch(() => null) as { email?: unknown } | null;
    return typeof data?.email === "string" && EMAIL_PATTERN.test(data.email) ? { email: data.email } : {};
  } catch {
    return {};
  }
}
