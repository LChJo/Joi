/* Synthetic OAuth and inference transports exercise disposable storage. */
/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { createServer, get, type IncomingHttpHeaders } from "node:http";
import { ModelSourceService } from "../../src/main/application/model-sources/model-source-service.js";
import { SubscriptionLoginService } from "../../src/main/application/model-sources/codex-login-service.js";
import { SubscriptionLoginDiagnostics } from "../../src/main/application/model-sources/subscription-login-diagnostics.js";
import { SqliteModelSourceRepository } from "../../src/main/infrastructure/persistence/sqlite-model-source-repository.js";
import { SqlitePiCredentialRepository } from "../../src/main/infrastructure/persistence/sqlite-pi-credential-repository.js";
import { PiAntigravityAuthorization } from "../../src/main/infrastructure/pi/pi-antigravity-authorization.js";
import { RepositoryPiConfiguredModelResolver } from "../../src/main/infrastructure/pi/pi-configured-model-resolver.js";
import { SafeStoragePiCredentialStore } from "../../src/main/infrastructure/pi/pi-credential-store-adapter.js";
import { revokeAntigravityToken } from "../../src/main/infrastructure/pi/antigravity-revocation.js";
import { PiModelSourceCatalog } from "../../src/main/infrastructure/pi/pi-model-source-catalog.js";
import { PiModelSourceValidator } from "../../src/main/infrastructure/pi/pi-model-source-validator.js";
import { ANTIGRAVITY_REDIRECT_URI } from "../../src/shared/antigravity-authorization.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

function requestCallback(port: number, callback: string): Promise<{ status: number | undefined; headers: IncomingHttpHeaders }> {
  const url = new URL(callback);
  return new Promise((resolve, reject) => {
    get({ hostname: "127.0.0.1", port, path: url.pathname + url.search, headers: { host: url.host } }, response => {
      response.resume();
      resolve({ status: response.statusCode, headers: response.headers });
    }).on("error", reject);
  });
}

const BUILTIN_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolo" + "jh4g403ep.apps.googleusercontent.com";
const BUILTIN_CLIENT_SECRET = "GOCSPX-K58FWR486LdLJ1m" + "LB8sXC4z6qDAf";

describe("Antigravity subscription model network", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("authorizes, encrypts, refreshes and runs text and tool turns through Pi", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-antigravity-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    const repository = new SqliteModelSourceRepository(database);
    const records = new SqlitePiCredentialRepository(database);
    const credentials = new SafeStoragePiCredentialStore({ records, vault: {
      isAvailable: () => true,
      encrypt: async (value) => Buffer.from(value).map((byte) => byte ^ 0xa7),
      decrypt: async (blob) => Buffer.from(blob).map((byte) => byte ^ 0xa7).toString(),
    } });
    const clock = new TestClock();
    const diagnostics = new SubscriptionLoginDiagnostics(clock);
    const sources = new ModelSourceService({
      catalog: new PiModelSourceCatalog(), clock, ids: new TestIds(), repository, secrets: credentials,
      endpointPolicy: { validate: async () => { throw new Error("No custom endpoint"); } },
      validator: new PiModelSourceValidator({ clock, credentials }),
      revokeAntigravity: (refreshToken) => revokeAntigravityToken(refreshToken),
      revocations: diagnostics,
    });
    const authorization = new PiAntigravityAuthorization(server => {
      server.emit("error", Object.assign(new Error("Fixture callback port is reserved"), { code: "EACCES" }));
    });
    const login = new SubscriptionLoginService({ provider: "antigravity", authorization, ids: new TestIds(),
      connect: (credential, signal, id) => sources.connectAntigravity(credential, signal, id) });
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const revoked: string[] = [];
    let revokeStatus = 200;
    let tool = false;
    let denial: (() => Response) | undefined;
    let refreshes = 0;
    let verifier = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        expect(body.get("client_id")).toBe(BUILTIN_CLIENT_ID);
        expect(body.get("client_secret")).toBe(BUILTIN_CLIENT_SECRET);
        if (body.get("grant_type") === "refresh_token") refreshes++;
        else { verifier = body.get("code_verifier") ?? ""; expect(body.get("code")).toBe("fixture-code"); }
        return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: refreshes === 0 ? 1 : 3600,
          scope: "https://www.googleapis.com/auth/aicode https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs" });
      }
      if (url === "https://www.googleapis.com/oauth2/v3/userinfo") {
        return Response.json({ email: "brycen@gmail.com" });
      }
      if (url === "https://oauth2.googleapis.com/revoke") {
        revoked.push(new URLSearchParams(typeof init?.body === "string" ? init.body : "").get("token") ?? "");
        return new Response(null, { status: revokeStatus });
      }
      if (url.endsWith(":loadCodeAssist")) return Response.json({ cloudaicompanionProject: "fixture-project" });
      requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(typeof init?.body === "string" ? init.body : "") as Record<string, unknown> });
      if (denial !== undefined) return denial();
      const response = { candidates: [{ content: { role: "model", parts: tool
        ? [{ functionCall: { name: "fixture_tool", args: {} }, thoughtSignature: "Zml4dHVyZS1zaWduYXR1cmU=" }]
        : [{ text: "OK" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } };
      const sse = `data: ${JSON.stringify({ response })}\r\n\r\n`;
      const bytes = new TextEncoder().encode(sse);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, 19)); controller.enqueue(bytes.slice(19)); controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    }));
    try {
      await expect(sources.create({ kind: "antigravity", apiKey: "no-api-key" })).rejects.toMatchObject({ code: "antigravity_oauth_required" });
      const started = login.start("desktop", "browser");
      const browser = await vi.waitFor(() => {
        const result = login.status("desktop", started.attemptId);
        expect(result.status).toBe("browser");
        if (result.status !== "browser") throw new Error("pending");
        return result;
      });
      const auth = new URL(browser.url);
      expect(auth.origin).toBe("https://accounts.google.com");
      expect(auth.searchParams.get("client_id")).toBe(BUILTIN_CLIENT_ID);
      expect(auth.searchParams.has("client_secret")).toBe(false);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      const challenge = auth.searchParams.get("code_challenge") ?? "";
      const callback = `http://localhost:51121/oauth-callback?code=fixture-code&state=${auth.searchParams.get("state") ?? ""}`;
      expect(() => login.submitCallback("desktop", started.attemptId, callback.replace("51121", "1455"))).toThrow();
      login.submitCallback("desktop", started.attemptId, callback);
      const connected = await vi.waitFor(() => {
        const result = login.status("desktop", started.attemptId);
        expect(result.status).toBe("completed");
        if (result.status !== "completed") throw new Error("pending");
        return result.source;
      });
      expect(connected, connected.reasonCode).toMatchObject({ kind: "antigravity", status: "READY", accessMode: "coding-plan", protocol: "google" });
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
      expect(refreshes).toBe(1);
      expect(JSON.stringify(connected)).not.toMatch(/synthetic|fixture-project|credentialRef/u);
      const resolved = await new RepositoryPiConfiguredModelResolver({ credentials, repository }).resolve({
        sourceId: connected.sourceId, sourceRevisionId: connected.activeSourceRevisionId,
        modelId: connected.activeModel.id, modelRevisionId: connected.activeModel.revisionId,
      });
      const { model, models } = resolved;
      const messages = [{ role: "system" as const, timestamp: 1, content: "A long system instruction. ".repeat(12),
        toolsAdded: [{ name: "fixture_tool", description: "Fixture", parameters: Type.Object({}) }] },
      { role: "user" as const, timestamp: 2, content: "Use fixture" }];
      tool = true;
      const call = await models.completeSimple(model, { messages }, { reasoning: "high", maxTokens: 64 });
      expect(call.stopReason, call.errorMessage).toBe("toolUse");
      const block = call.content.find((block) => block.type === "toolCall");
      expect(block).toMatchObject({ name: "fixture_tool", arguments: {}, thoughtSignature: "Zml4dHVyZS1zaWduYXR1cmU=" });
      if (block?.type !== "toolCall") throw new Error("missing tool");
      tool = false;
      const reply = await models.completeSimple(model, { messages: [...messages, call, {
        role: "toolResult", toolCallId: block.id, toolName: block.name, content: [{ type: "text", text: "fixture done" }], isError: false, timestamp: 3,
      }] }, { maxTokens: 64 });
      expect(reply.content).toContainEqual(expect.objectContaining({ type: "text", text: "OK" }));
      expect(JSON.stringify(requests.at(-1)?.body)).toContain("Zml4dHVyZS1zaWduYXR1cmU=");
      for (const request of requests) {
        expect(request.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
        expect(request.headers.get("authorization")).toBe("Bearer synthetic-access");
        expect(request.headers.has("x-goog-api-key")).toBe(false);
        expect(request.body).toMatchObject({ project: "fixture-project", requestType: "agent", userAgent: "antigravity" });
      }
      expect(requests[1]?.body).toMatchObject({ model: "gemini-3.8-flash-high", request: { generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: -1 } } } });
      expect((requests[1]?.body.request as Record<string, unknown>).systemInstruction).toBeUndefined();
      expect(Buffer.from((await records.read(model.provider))?.encryptedBlob ?? []).toString()).not.toContain("synthetic");
      const decrypted = Buffer.from((await records.read(model.provider))?.encryptedBlob ?? []).map((byte) => byte ^ 0xa7).toString();
      expect(decrypted).toContain("brycen@gmail.com");
      expect(decrypted).toContain("\"scopes\"");
      expect(JSON.stringify(await sources.list(true))).not.toContain("brycen@gmail.com");
      const account = (await sources.list(true)).find((source) => source.sourceId === connected.sourceId)?.codexAccount;
      expect(account).toMatchObject({ maskedAccount: "b***@gmail.com",
        scopes: ["aicode", "cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"] });
      await expect(sources.update(connected.sourceId, { apiKey: "no" })).rejects.toMatchObject({ code: "antigravity_oauth_required" });
      await expect(sources.update(connected.sourceId, { modelId: "gemini-4-neon" })).rejects.toMatchObject({ code: "antigravity_model_unavailable" });
      denial = () => new Response("private-provider-error", { status: 401 });
      expect(await sources.validate(connected.sourceId)).toMatchObject({ status: "NEEDS_AUTH", reasonCode: "auth_failed" });
      denial = () => Response.json({ error: { details: [{ reason: "LOCATION_NOT_ELIGIBLE" }],message: "private-provider-error" } }, { status: 403 });
      expect(await sources.validate(connected.sourceId)).toMatchObject({ status: "NEEDS_AUTH", reasonCode: "region_forbidden" });
      denial = () => Response.json({ error: { message: "User location is not supported for the API use." } }, { status: 400 });
      expect(await sources.validate(connected.sourceId)).toMatchObject({ status: "NEEDS_AUTH", reasonCode: "region_forbidden" });
      denial = () => Response.json({ error: { message: "private-provider-error" } }, { status: 403 });
      expect(await sources.validate(connected.sourceId)).toMatchObject({ status: "NEEDS_AUTH", reasonCode: "http_403" });
      denial = () => Response.json({ error: { details: [{ reason: "LOCATION_NOT_ELIGIBLE" }],message: "private-provider-error".repeat(512) } }, { status: 403 });
      expect(await sources.validate(connected.sourceId)).toMatchObject({ status: "NEEDS_AUTH", reasonCode: "http_403" });
      expect(JSON.stringify(await sources.list())).not.toContain("private-provider-error");
      denial = undefined;
      revokeStatus = 500;
      const reconnected = await sources.connectAntigravity({ access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3600_000, projectId: "fixture-project" }, new AbortController().signal, connected.sourceId);
      expect(reconnected).toMatchObject({ sourceId: connected.sourceId, status: "READY" });
      expect(revoked).toEqual(["synthetic-refresh"]);
      expect(await records.read(model.provider)).toBeNull();
      await sources.delete(connected.sourceId);
      expect(await records.list()).toEqual([]);
      expect(revoked).toEqual(["synthetic-refresh", "synthetic-refresh"]);
      expect(diagnostics.revocations()).toMatchObject([
        { kind: "antigravity", trigger: "reconnect", outcome: "failed", reasonCode: "revoke_failed" },
        { kind: "antigravity", trigger: "delete", outcome: "failed", reasonCode: "revoke_failed" },
      ]);
    } finally {
      await login.close(); vi.unstubAllGlobals(); database.close(); await rm(root, { recursive: true, force: true });
    }
  });

  it("uses a fully provided override pair in place of the built-in credentials", async () => {
    vi.stubEnv("JOI_ANTIGRAVITY_OAUTH_CLIENT_ID", "fixture-desktop-client-id");
    vi.stubEnv("JOI_ANTIGRAVITY_OAUTH_CLIENT_SECRET", "fixture-desktop-client-secret");
    let state = "";
    let tokenClient: string | undefined;
    let tokenSecret: string | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        tokenClient = body.get("client_id") ?? undefined;
        tokenSecret = body.get("client_secret") ?? undefined;
        return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 });
      }
      return Response.json({ cloudaicompanionProject: "fixture-project" });
    }));
    const authorization = new PiAntigravityAuthorization(server => {
      server.emit("error", Object.assign(new Error("Fixture callback port is reserved"), { code: "EACCES" }));
    });
    try {
      const credential = await authorization.authorize({
        method: "browser", signal: new AbortController().signal,
        showBrowser: (url) => { state = new URL(url).searchParams.get("state") ?? ""; },
        showDeviceCode: vi.fn(),
        waitForCallback: () => Promise.resolve(`${ANTIGRAVITY_REDIRECT_URI}?code=fixture-code&state=${state}`),
      });
      expect(credential).toMatchObject({ access: "synthetic-access", projectId: "fixture-project" });
      expect(tokenClient).toBe("fixture-desktop-client-id");
      expect(tokenSecret).toBe("fixture-desktop-client-secret");
    } finally { vi.unstubAllGlobals(); }
  });

  it("completes sign-in without an account email when userinfo is unavailable", async () => {
    let state = "";
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600,
          scope: "https://www.googleapis.com/auth/aicode https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs" });
      }
      if (url === "https://www.googleapis.com/oauth2/v3/userinfo") return new Response("private-userinfo-error", { status: 401 });
      return Response.json({ cloudaicompanionProject: "fixture-project" });
    }));
    const authorization = new PiAntigravityAuthorization(server => {
      server.emit("error", Object.assign(new Error("Fixture callback port is reserved"), { code: "EACCES" }));
    });
    try {
      const credential = await authorization.authorize({
        method: "browser", signal: new AbortController().signal,
        showBrowser: (url) => { state = new URL(url).searchParams.get("state") ?? ""; },
        showDeviceCode: vi.fn(),
        waitForCallback: () => Promise.resolve(`${ANTIGRAVITY_REDIRECT_URI}?code=fixture-code&state=${state}`),
      });
      expect(credential).toMatchObject({ access: "synthetic-access", projectId: "fixture-project",
        scopes: ["aicode", "cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"] });
      expect(credential.accountEmail).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });

  it("captures the loopback callback, rejects mismatched state and releases the port on cancellation", async () => {
    let authorizing: URL | undefined;
    let port = 0;
    const authorization = new PiAntigravityAuthorization((server, listening) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Expected a loopback address");
        port = address.port;
        listening();
      });
    });
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (url) => String(url).endsWith("/token")
      ? Response.json({ access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 3600 })
      : Response.json({ cloudaicompanionProject: "fixture-project" })));
    const waiting = authorization.authorize({ method: "browser", signal: controller.signal,
      showBrowser: (url) => { authorizing = new URL(url); }, showDeviceCode: () => { throw new Error("Unexpected device code"); },
      waitForCallback: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("canceled")), { once: true })),
    });
    try {
      await vi.waitFor(() => expect(authorizing).toBeDefined());
      const callback = `${ANTIGRAVITY_REDIRECT_URI}?code=fixture&state=${authorizing?.searchParams.get("state") ?? ""}`;
      expect((await requestCallback(port, callback.replace(/state=.*$/u, "state=mismatch"))).status).toBe(400);
      const response = await requestCallback(port, callback);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(await waiting).toMatchObject({ access: "synthetic-access", projectId: "fixture-project" });
    } finally { controller.abort(); await waiting.catch(() => undefined); vi.unstubAllGlobals(); }

    const canceled = new AbortController();
    const next = authorization.authorize({ method: "browser", signal: canceled.signal,
      showBrowser: () => canceled.abort(), showDeviceCode: () => undefined,
      waitForCallback: (signal) => signal.aborted ? Promise.reject(new Error("canceled")) : new Promise(() => undefined),
    });
    await expect(next).rejects.toThrow();
    const listener = createServer();
    try { await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(port, "127.0.0.1", resolve)); }
    finally { listener.close(); }
  });
});
