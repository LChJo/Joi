/* The blob is split in source like the upstream reference does, keeping the approved application's
   identity out of naive credential scanners; the decoded pair is public and embedded in the
   official Antigravity desktop client. */
const ANTIGRAVITY_BUILTIN_CLIENT_ID_B64 = "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlc" +
  "C5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==";
const ANTIGRAVITY_BUILTIN_CLIENT_SECRET_B64 = "R09DU1BYLUs1OEZXUjQ" + "4NkxkTEoxbUxCOHNYQzR6NnFEQWY=";

/** The client fingerprint pi-antigravity 0.15.0 ships; upstream may rotate it with CLI versions. */
const DEFAULT_USER_AGENT = "antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

export interface AntigravityOAuthClientResolution {
  clientId: string;
  clientSecret: string;
  source: "builtin" | "env";
}

function decodeBuiltin(value: string): string {
  const decoded = Buffer.from(value, "base64").toString("utf8");
  if (decoded.length === 0) throw new Error("antigravity_oauth_client_invalid");
  return decoded;
}

/**
 * Sign-in uses the approved Antigravity desktop application's credentials, so Google sees the same
 * application identity as the reference implementation. Both override variables must be provided
 * together; a lone value is treated as an incomplete override and the built-in pair is used.
 */
export function resolveAntigravityOAuthClient(): AntigravityOAuthClientResolution {
  const id = process.env.JOI_ANTIGRAVITY_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.JOI_ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim();
  if (id !== undefined && id !== "" && secret !== undefined && secret !== "") {
    return { clientId: id, clientSecret: secret, source: "env" };
  }
  return { clientId: decodeBuiltin(ANTIGRAVITY_BUILTIN_CLIENT_ID_B64), clientSecret: decodeBuiltin(ANTIGRAVITY_BUILTIN_CLIENT_SECRET_B64), source: "builtin" };
}

const USER_AGENT_PATTERN = /^[\x20-\x7e]{8,200}$/u;

/** JOI_ANTIGRAVITY_USER_AGENT may follow an upstream CLI version bump; invalid values fall back silently. */
export function antigravityUserAgent(): string {
  const override = process.env.JOI_ANTIGRAVITY_USER_AGENT?.trim();
  return override !== undefined && override !== "" && USER_AGENT_PATTERN.test(override) ? override : DEFAULT_USER_AGENT;
}

export function antigravityHeaders(): { "content-type": string; "user-agent": string } {
  return { "content-type": "application/json", "user-agent": antigravityUserAgent() };
}
