import { antigravityHeaders, antigravityUserAgent, resolveAntigravityOAuthClient } from "../../src/main/infrastructure/pi/antigravity-oauth-client.js";

const BUILTIN_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolo" + "jh4g403ep.apps.googleusercontent.com";
const BUILTIN_CLIENT_SECRET = "GOCSPX-K58FWR486LdLJ1m" + "LB8sXC4z6qDAf";
const DEFAULT_USER_AGENT = "antigravity/cli/1.5.5 (aidev_client; os_type=linux; arch=amd64; cl=982146307; auth_method=consumer)";

describe("Antigravity OAuth client resolution", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("falls back to the built-in approved application credentials when no override is configured", () => {
    const resolution = resolveAntigravityOAuthClient();
    expect(resolution).toEqual({ clientId: BUILTIN_CLIENT_ID, clientSecret: BUILTIN_CLIENT_SECRET, source: "builtin" });
  });

  it("uses the override pair only when both variables are provided", () => {
    vi.stubEnv("JOI_ANTIGRAVITY_OAUTH_CLIENT_ID", " fixture-client-id ");
    vi.stubEnv("JOI_ANTIGRAVITY_OAUTH_CLIENT_SECRET", "fixture-client-secret");
    expect(resolveAntigravityOAuthClient()).toEqual({ clientId: "fixture-client-id", clientSecret: "fixture-client-secret", source: "env" });
  });

  it.each([
    ["client id only", { id: "fixture-client-id", secret: undefined }],
    ["client secret only", { id: undefined, secret: "fixture-client-secret" }],
    ["blank client id", { id: "   ", secret: "fixture-client-secret" }],
    ["blank client secret", { id: "fixture-client-id", secret: "" }],
  ])("treats an incomplete override (%s) as built-in", (_name, override) => {
    if (override.id !== undefined) vi.stubEnv("JOI_ANTIGRAVITY_OAUTH_CLIENT_ID", override.id);
    if (override.secret !== undefined) vi.stubEnv("JOI_ANTIGRAVITY_OAUTH_CLIENT_SECRET", override.secret);
    const resolution = resolveAntigravityOAuthClient();
    expect(resolution.clientId).toBe(BUILTIN_CLIENT_ID);
    expect(resolution.clientSecret).toBe(BUILTIN_CLIENT_SECRET);
    expect(resolution.source).toBe("builtin");
  });
});

describe("Antigravity user agent", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to the reference implementation fingerprint", () => {
    expect(antigravityUserAgent()).toBe(DEFAULT_USER_AGENT);
    expect(antigravityHeaders()).toEqual({ "content-type": "application/json", "user-agent": DEFAULT_USER_AGENT });
  });

  it("accepts a printable ASCII override", () => {
    vi.stubEnv("JOI_ANTIGRAVITY_USER_AGENT", "antigravity/cli/1.6.0 (aidev_client; os_type=windows)");
    expect(antigravityUserAgent()).toBe("antigravity/cli/1.6.0 (aidev_client; os_type=windows)");
  });

  it.each([
    ["empty value", ""],
    ["too short", "short"],
    ["too long", "a".repeat(201)],
    ["non-ascii", "antigravity/cli/日本語"],
  ])("silently falls back for an invalid override (%s)", (_name, value) => {
    vi.stubEnv("JOI_ANTIGRAVITY_USER_AGENT", value);
    expect(antigravityUserAgent()).toBe(DEFAULT_USER_AGENT);
  });
});
