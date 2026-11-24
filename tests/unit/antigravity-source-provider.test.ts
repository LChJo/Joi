/* Synthetic responses exercise the production Pi transport without account files. */
/* eslint-disable @typescript-eslint/require-await */
import { createModels, type CredentialStore } from "@earendil-works/pi-ai";
import { createAntigravitySourceProvider, antigravityModelLimits } from "../../src/main/infrastructure/pi/antigravity-source-provider.js";
import { PiModelSourceCatalog } from "../../src/main/infrastructure/pi/pi-model-source-catalog.js";
import { isAntigravityAuthorizationUrl } from "../../src/shared/antigravity-authorization.js";

function fixture() {
  const credentials: CredentialStore = {
    read: () => Promise.resolve({ type: "oauth", access: "fixture-access", refresh: "fixture-refresh", projectId: "fixture-project", expires: Date.now() + 3600_000 }),
    list: () => Promise.resolve([]), delete: () => Promise.resolve(), modify: () => Promise.reject(new Error("Unexpected refresh")),
  };
  const models = createModels({ credentials, authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) } });
  return models;
}

describe("Antigravity source routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["gemini-3.8-flash", "high", "gemini-3.8-flash-high", -1],
    ["gemini-3.7-flash", "medium", "gemini-3.7-flash-medium", 4000],
    ["gemini-3.6-flash", "off", "gemini-3.6-flash-low", 0],
    ["gemini-3.5-flash", "high", "gemini-3-flash-agent", 10_000],
    ["gemini-3.1-pro", "high", "gemini-pro-agent", 10_001],
    ["claude-sonnet-4-6", "high", "claude-sonnet-4-6", 1024],
    ["claude-opus-4-6", "high", "claude-opus-4-6-thinking", 1024],
    ["gpt-oss-120b", "medium", "gpt-oss-120b-medium", 8192],
  ] as const)("routes %s with %s effort", async (modelId, thinkingEffort, runtime, budget) => {
    const provider = createAntigravitySourceProvider({ kind: "antigravity", credentialRef: "fixture", sourceId: "fixture", modelId, thinkingEffort });
    const models = fixture(); models.setProvider(provider);
    const fetch = vi.fn(async () => new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n', { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const model = provider.getModels()[0];
    if (model === undefined) throw new Error("Missing fixture model");
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: 1 }] }, { maxTokens: 100, maxRetries: 0 });
    expect(result.stopReason, result.errorMessage).toBe("stop");
    const body = JSON.parse(((fetch.mock.calls[0] as unknown as [unknown, RequestInit])[1].body as string)) as unknown;
    expect(body).toMatchObject({ model: runtime, request: { generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: budget } } } });
  });

  it("limits output, rejects foreign protocols and keeps models unproven until tools execute", () => {
    const catalog = new PiModelSourceCatalog();
    expect(catalog.resolve("antigravity")).toMatchObject({ protocol: "google", accessMode: "coding-plan", capability: "custom-unverified-tools" });
    for (const protocol of ["openai", "anthropic"] as const) expect(() => catalog.resolve("antigravity", undefined, undefined, protocol)).toThrow();
    expect(() => catalog.resolve("generic-openai", "fixture", "custom", "google")).toThrow();
    expect(() => catalog.resolve("antigravity", "unknown-model")).toThrow();
    expect(antigravityModelLimits({ sourceId: "fixture", modelId: "gemini-3.8-flash", contextWindow: 2_000_000, maxOutputTokens: 131_072 }))
      .toEqual({ contextWindow: 1_048_576, maxOutputTokens: 65_536 });
  });

  it("allows only the Google authorization endpoint", () => {
    expect(isAntigravityAuthorizationUrl("https://accounts.google.com/o/oauth2/v2/auth?state=fixture")).toBe(true);
    for (const url of ["http://accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com.evil.test/o/oauth2/v2/auth",
      "https://accounts.google.com/o/oauth2/v2/auth#fragment", "https://user@accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com/"]) {
      expect(isAntigravityAuthorizationUrl(url)).toBe(false);
    }
  });

  it.each([
    'data: private-provider-body\n\n',
    'data: {"response":{"candidates":[{"content":{"parts":[{"text":"private-provider-body"}]}}]}}\n\n',
  ])("fails safely on a malformed or incomplete upstream stream", async (stream) => {
    const provider = createAntigravitySourceProvider({ kind: "antigravity", credentialRef: "fixture", sourceId: "fixture", modelId: "gemini-3.8-flash" });
    const models = fixture(); models.setProvider(provider);
    const model = provider.getModels()[0];
    if (model === undefined) throw new Error("Missing fixture model");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } })));
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: 1 }] }, { maxRetries: 0 });
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).not.toContain("private-provider-body");
  });

  it("uses the second Google endpoint on a pre-stream server failure with the same request identity", async () => {
    const provider = createAntigravitySourceProvider({ kind: "antigravity", credentialRef: "fixture", sourceId: "fixture", modelId: "gemini-3.8-flash" });
    const models = fixture(); models.setProvider(provider);
    const model = provider.getModels()[0];
    if (model === undefined) throw new Error("Missing fixture model");
    const requests: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init: RequestInit) => {
      requests.push({ url: String(url), body: typeof init.body === "string" ? init.body : "" });
      return requests.length === 1 ? new Response("private-server-error", { status: 503 })
        : new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n', { headers: { "content-type": "text/event-stream" } });
    }));
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: 1 }] }, { maxRetries: 0 });
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(requests.map(({ url }) => new URL(url).hostname)).toEqual(["daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"]);
    expect(requests[1]?.body).toBe(requests[0]?.body);
  });

  it("caps an explicit request at the source's effective output limit", async () => {
    const provider = createAntigravitySourceProvider({ kind: "antigravity", credentialRef: "fixture", sourceId: "fixture",
      modelId: "gemini-3.8-flash", maxOutputTokens: 512 });
    const models = fixture(); models.setProvider(provider);
    const model = provider.getModels()[0];
    if (model === undefined) throw new Error("Missing fixture model");
    let sent: unknown;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      sent = JSON.parse(typeof init.body === "string" ? init.body : "") as unknown;
      return new Response('data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n', { headers: { "content-type": "text/event-stream" } });
    }));
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: 1 }] }, { maxTokens: 131_072 });
    expect(result.stopReason).toBe("stop");
    expect(sent).toMatchObject({ request: { generationConfig: { maxOutputTokens: 512 } } });
  });
});
