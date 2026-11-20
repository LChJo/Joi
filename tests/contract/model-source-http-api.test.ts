/* Immediate API doubles implement asynchronous application contracts. */
/* eslint-disable @typescript-eslint/require-await */
import type { UpdateModelSourceRequest } from "../../src/main/application/model-sources/model-source-service.js";
import { CodexLoginService } from "../../src/main/application/model-sources/codex-login-service.js";
import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import type { ModelSourceDto } from "../../src/shared/joi.js";
import { createRuntimeFixture, TestIds } from "../support/runtime-fixture.js";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

describe("model source HTTP API", () => {
  it("binds Codex sign-in to the desktop session and checks callback state", async () => {
    const fixture = await createRuntimeFixture();
    const connect = vi.fn().mockResolvedValue({ sourceId: "codex-source", kind: "codex", status: "READY" });
    const login = new CodexLoginService({
      ids: new TestIds(), sources: { connectCodex: connect },
      authorization: {
        authorize: async (input) => {
          input.showBrowser("https://auth.openai.com/oauth/authorize?state=expected");
          await input.waitForCallback(input.signal);
          return { access: "private-access", refresh: "private-refresh", expires: 100 };
        },
      },
    });
    const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, codexLogin: login }), loopbackPort: 0 });
    const base = listeners.loopback.url;
    const path = `${base}/api/v1/model-sources/codex-login`;
    const password = "disposable local Codex test";
    const desktopHeaders = async () => {
      const { nonce } = await fixture.auth.issueDesktopBootstrap();
      const response = await fetch(`${base}/api/v1/auth/bootstrap`, {
        method: "POST", body: JSON.stringify({ nonce }), headers: { "content-type": "application/json", origin: "null" },
      });
      const cookie = cookieFrom(response);
      const grant = await response.json() as { csrfToken: string };
      return { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": grant.csrfToken };
    };
    try {
      const desktop = await desktopHeaders();
      await fetch(`${base}/api/v1/auth/setup`, { method: "POST", headers: desktop, body: JSON.stringify({ password }) });
      const lan = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ password }),
      });
      const lanCookie = cookieFrom(lan);
      const lanGrant = await lan.json() as { csrfToken: string };
      const request = { method: "POST", body: JSON.stringify({ method: "browser" }) };
      expect((await fetch(path, {
        ...request, headers: { origin: base, cookie: lanCookie, "content-type": "application/json", "x-csrf-token": lanGrant.csrfToken },
      })).status).toBe(403);
      expect((await fetch(path, {
        ...request, headers: { origin: "null", cookie: desktop.cookie, "content-type": "application/json" },
      })).status).toBe(403);
      const started = await fetch(path, { ...request, headers: desktop });
      expect(started.status).toBe(202);
      const { attemptId } = await started.json() as { attemptId: string };
      const attempt = `${path}/${attemptId}`;
      const otherDesktop = await desktopHeaders();
      expect((await fetch(attempt, { headers: otherDesktop })).status).toBe(404);
      expect((await fetch(attempt, { headers: { cookie: lanCookie } })).status).toBe(403);
      const submit = (state: string) => fetch(`${attempt}/callback`, {
        method: "POST", headers: desktop, body: JSON.stringify({ callbackUrl: `http://localhost:1455/auth/callback?code=private-callback&state=${state}` }),
      });
      expect((await submit("mismatch")).status).toBe(400);
      expect(connect).not.toHaveBeenCalled();
      expect((await submit("expected")).status).toBe(204);
      const status = await fetch(attempt, { headers: desktop });
      expect(status.headers.get("cache-control")).toBe("no-store");
      const body = await status.text();
      expect(JSON.parse(body)).toMatchObject({ status: "completed", source: { kind: "codex" } });
      expect(body).not.toMatch(/private-|expected/u);
      expect(connect).toHaveBeenCalledTimes(1);
      expect((await submit("expected")).status).toBe(400);

      const next = await fetch(path, { ...request, headers: desktop });
      const { attemptId: nextId } = await next.json() as { attemptId: string };
      const nextAttempt = `${path}/${nextId}`;
      expect((await fetch(nextAttempt, { method: "DELETE", headers: desktop })).status).toBe(204);
      expect(await (await fetch(nextAttempt, { headers: desktop })).json()).toMatchObject({ status: "canceled" });
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      await login.close();
      await listeners.close();
      await fixture.close();
    }
  });

  it("keeps writes behind session/CSRF and never returns submitted credentials", async () => {
    const fixture = await createRuntimeFixture();
    const items: ModelSourceDto[] = [];
    const receivedKeys: string[] = [];
    const current = () => {
      const item = items[0];
      if (item === undefined) throw new Error("model source fixture missing");
      return item;
    };
    const modelSources = {
      create: async (input: { accessMode?: "api" | "coding-plan" | "token-plan" | "custom"; apiKey: string; kind: "kimi" | "qwen"; protocol?: "openai" | "anthropic" }) => {
        receivedKeys.push(input.apiKey);
        const source: ModelSourceDto = {
          accessMode: input.accessMode ?? "api",
          activeModel: { capability: "release-tested", id: "kimi-k2.5", revisionId: "model-1" },
          activeSourceRevisionId: "source-revision-1",
          credential: { configured: true, version: 1 },
          displayName: "Kimi",
          kind: input.kind,
          order: 0,
          primary: true,
          protocol: input.protocol ?? "openai",
          sourceId: "source-1",
          status: "DRAFT",
        };
        items.push(source);
        return source;
      },
      delete: async () => undefined,
      disable: async () => current(),
      hasReadySource: async () => false,
      list: async () => items,
      setOrder: async () => items,
      update: async () => current(),
      validate: async () => ({ ...current(), status: "READY" as const }),
    };
    const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, modelSources }), loopbackPort: 0 });
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const grantResponse = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      const cookie = cookieFrom(grantResponse);
      const grant = await grantResponse.json() as { csrfToken: string };
      const writeHeaders = { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": grant.csrfToken };
      await fetch(`${listeners.loopback.url}/api/v1/auth/setup`, {
        body: JSON.stringify({ password: "correct horse battery staple" }), headers: writeHeaders, method: "POST",
      });

      const denied = await fetch(`${listeners.loopback.url}/api/v1/model-sources`, {
        body: JSON.stringify({ apiKey: "must-never-leak", kind: "kimi" }),
        headers: { "content-type": "application/json", cookie, origin: "null" },
        method: "POST",
      });
      expect(denied.status).toBe(403);
      const created = await fetch(`${listeners.loopback.url}/api/v1/model-sources`, {
        body: JSON.stringify({ accessMode: "coding-plan", apiKey: "must-never-leak", kind: "kimi", protocol: "anthropic" }), headers: writeHeaders, method: "POST",
      });
      expect(created.status).toBe(201);
      const listed = await fetch(`${listeners.loopback.url}/api/v1/model-sources`, { headers: { cookie } });
      const body = await listed.text();
      expect(receivedKeys).toEqual(["must-never-leak"]);
      expect(body).not.toContain("must-never-leak");
      expect(JSON.parse(body)).toMatchObject({ items: [{ accessMode: "coding-plan", credential: { configured: true, version: 1 }, kind: "kimi", protocol: "anthropic" }] });

      const tokenPlan = await fetch(`${listeners.loopback.url}/api/v1/model-sources`, {
        body: JSON.stringify({ accessMode: "token-plan", apiKey: "must-never-leak", kind: "qwen", protocol: "anthropic" }), headers: writeHeaders, method: "POST",
      });
      expect(tokenPlan.status).toBe(201);
      for (const item of items) { item.status = "DEGRADED"; item.reasonCode = "server_error"; }
      const runtime = await fetch(`${listeners.loopback.url}/api/v1/joi/runtime`, { headers: { cookie } });
      expect(await runtime.json()).toEqual({ configured: true, status: "DEGRADED", modelHealth: { ready: 0, recovering: 2, unavailable: 2 } });
      const snapshot = await fetch(`${listeners.loopback.url}/api/v1/joi`, { headers: { cookie } });
      expect(await snapshot.json()).toMatchObject({ runtime: { configured: true, status: "DEGRADED" } });
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("passes numeric model limits through PATCH instead of silently dropping them", async () => {
    const fixture = await createRuntimeFixture();
    const updates: { input: UpdateModelSourceRequest; sourceId: string }[] = [];
    const source: ModelSourceDto = {
      accessMode: "api",
      activeModel: { capability: "release-tested", id: "glm-5.2", revisionId: "model-1" },
      activeSourceRevisionId: "source-revision-1",
      credential: { configured: true, version: 1 },
      displayName: "GLM",
      kind: "glm",
      order: 0,
      primary: true,
      protocol: "openai",
      sourceId: "source-1",
      status: "DRAFT",
    };
    const modelSources = {
      create: async () => source,
      delete: async () => undefined,
      disable: async () => source,
      hasReadySource: async () => false,
      list: async () => [source],
      setOrder: async () => [source],
      update: async (sourceId: string, input: UpdateModelSourceRequest) => {
        updates.push({ input, sourceId });
        return source;
      },
      validate: async () => ({ ...source, status: "READY" as const }),
    };
    const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, modelSources }), loopbackPort: 0 });
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const grantResponse = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      const cookie = cookieFrom(grantResponse);
      const grant = await grantResponse.json() as { csrfToken: string };
      const writeHeaders = { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": grant.csrfToken };
      await fetch(`${listeners.loopback.url}/api/v1/auth/setup`, {
        body: JSON.stringify({ password: "correct horse battery staple" }), headers: writeHeaders, method: "POST",
      });
      const patch = (body: Record<string, unknown>) => fetch(`${listeners.loopback.url}/api/v1/model-sources/source-1`, {
        body: JSON.stringify(body), headers: writeHeaders, method: "PATCH",
      });

      // All three are numbers, and the string-typed filter the other fields go through would drop
      // them without a word — which is the bug this covers.
      expect((await patch({ contextWindow: 200_000, maxOutputTokens: 65_536 })).status).toBe(200);
      expect(updates[0]?.input).toEqual({ contextWindow: 200_000, maxOutputTokens: 65_536 });

      // null is the explicit "clear back to the preset" and has to survive the same filter.
      expect((await patch({ contextWindow: null })).status).toBe(200);
      expect(updates[1]?.input).toEqual({ contextWindow: null });

      expect((await patch({ contextWindow: "200000" })).status).toBe(400);
      expect((await patch({ compactionThresholdPercent: 1.5 })).status).toBe(400);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });

  it("passes the thinking effort through PATCH in all three states and rejects unknown tiers", async () => {
    const fixture = await createRuntimeFixture();
    const updates: { input: UpdateModelSourceRequest; sourceId: string }[] = [];
    const source: ModelSourceDto = {
      accessMode: "api",
      activeModel: { capability: "release-tested", id: "glm-5.3-flash", revisionId: "model-1", thinkingEffort: "low" },
      activeSourceRevisionId: "source-revision-1",
      credential: { configured: true, version: 1 },
      displayName: "GLM",
      kind: "glm",
      order: 0,
      primary: true,
      protocol: "anthropic",
      sourceId: "source-1",
      status: "DRAFT",
    };
    const modelSources = {
      create: async () => source,
      delete: async () => undefined,
      disable: async () => source,
      hasReadySource: async () => false,
      list: async () => [source],
      setOrder: async () => [source],
      update: async (sourceId: string, input: UpdateModelSourceRequest) => {
        updates.push({ input, sourceId });
        return source;
      },
      validate: async () => ({ ...source, status: "READY" as const }),
    };
    const listeners = await startRuntimeListeners({ handler: createApiHandler({ ...fixture, modelSources }), loopbackPort: 0 });
    try {
      const bootstrap = await fixture.auth.issueDesktopBootstrap();
      const grantResponse = await fetch(`${listeners.loopback.url}/api/v1/auth/bootstrap`, {
        body: JSON.stringify({ nonce: bootstrap.nonce }),
        headers: { "content-type": "application/json", origin: "null" },
        method: "POST",
      });
      const cookie = cookieFrom(grantResponse);
      const grant = await grantResponse.json() as { csrfToken: string };
      const writeHeaders = { "content-type": "application/json", cookie, origin: "null", "x-csrf-token": grant.csrfToken };
      await fetch(`${listeners.loopback.url}/api/v1/auth/setup`, {
        body: JSON.stringify({ password: "correct horse battery staple" }), headers: writeHeaders, method: "POST",
      });
      const patch = (body: Record<string, unknown>) => fetch(`${listeners.loopback.url}/api/v1/model-sources/source-1`, {
        body: JSON.stringify(body), headers: writeHeaders, method: "PATCH",
      });

      expect((await patch({ thinkingEffort: "high" })).status).toBe(200);
      expect(updates[0]?.input).toEqual({ thinkingEffort: "high" });

      // null is the "back to joi's allowlist judgement" state and must survive the filter.
      expect((await patch({ thinkingEffort: null })).status).toBe(200);
      expect(updates[1]?.input).toEqual({ thinkingEffort: null });

      // Omitted leaves it alone; the enum check rejects anything outside the tier list.
      expect((await patch({ displayName: "GLM" })).status).toBe(200);
      expect(updates[2]?.input).toEqual({ displayName: "GLM" });
      // "minimal" is a real pi-ai tier that joi deliberately does not expose.
      expect((await patch({ thinkingEffort: "minimal" })).status).toBe(400);
      expect((await patch({ thinkingEffort: 3 })).status).toBe(400);
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
