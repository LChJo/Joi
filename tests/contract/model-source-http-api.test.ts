/* Immediate API doubles implement asynchronous application contracts. */
/* eslint-disable @typescript-eslint/require-await */
import { createApiHandler } from "../../src/main/interfaces/http/api-handler.js";
import { startRuntimeListeners } from "../../src/main/interfaces/http/runtime-listeners.js";
import type { ModelSourceDto } from "../../src/shared/joi.js";
import { createRuntimeFixture } from "../support/runtime-fixture.js";

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (value === null) throw new Error("missing session cookie");
  return value.split(";", 1)[0] ?? "";
}

describe("model source HTTP API", () => {
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
    } finally {
      await listeners.close();
      await fixture.close();
    }
  });
});
