/* The OAuth and inference transports use synthetic responses and disposable storage. */
/* eslint-disable @typescript-eslint/require-await */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import type { Message } from "@earendil-works/pi-ai";
import { ModelSourceService } from "../../src/main/application/model-sources/model-source-service.js";
import { CodexLoginService } from "../../src/main/application/model-sources/codex-login-service.js";
import { SqliteModelSourceRepository } from "../../src/main/infrastructure/persistence/sqlite-model-source-repository.js";
import { SqlitePiCredentialRepository } from "../../src/main/infrastructure/persistence/sqlite-pi-credential-repository.js";
import { PiCodexAuthorization } from "../../src/main/infrastructure/pi/pi-codex-authorization.js";
import { RepositoryPiConfiguredModelResolver } from "../../src/main/infrastructure/pi/pi-configured-model-resolver.js";
import { SafeStoragePiCredentialStore } from "../../src/main/infrastructure/pi/pi-credential-store-adapter.js";
import { PiModelSourceCatalog } from "../../src/main/infrastructure/pi/pi-model-source-catalog.js";
import { PiModelSourceValidator } from "../../src/main/infrastructure/pi/pi-model-source-validator.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

function accessToken(account: string): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_plan_type: "plus" } };
  return `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test`;
}

function codexResponse(text: string, toolCall = false) {
  const item = toolCall
    ? { id: "fc_test", type: "function_call", call_id: "call_test", name: "fixture_tool", arguments: "{}" }
    : { id: "msg_codex_test", type: "message", role: "assistant", content: [] };
  const events: object[] = toolCall ? [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
  ] : [
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: { ...item, content: [{ type: "output_text", text }] } },
  ];
  events.push({ type: "response.completed", response: { id: "resp_codex_test", status: "completed", output: [] } });
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Codex subscription model network", () => {
  it("authorizes, persists, refreshes and streams with the real Pi Codex provider", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-codex-source-"));
    const database = await openRuntimeDatabaseFixture(path.join(root, "runtime.sqlite"));
    const repository = new SqliteModelSourceRepository(database);
    const credentialRecords = new SqlitePiCredentialRepository(database);
    const credentials = new SafeStoragePiCredentialStore({
      records: credentialRecords,
      vault: {
        isAvailable: () => true,
        encrypt: async (value) => Buffer.from(value).map((byte) => byte ^ 0xa7),
        decrypt: async (blob) => Buffer.from(blob).map((byte) => byte ^ 0xa7).toString(),
      },
    });
    const clock = new TestClock();
    const ids = new TestIds();
    const sources = new ModelSourceService({
      catalog: new PiModelSourceCatalog(), clock, ids, repository, secrets: credentials,
      endpointPolicy: { validate: () => { throw new Error("unexpected custom endpoint"); } },
      validator: new PiModelSourceValidator({ clock, credentials }),
    });
    const logins = new CodexLoginService({ authorization: new PiCodexAuthorization(), ids, sources });
    const requests: { account: string | null; authorization: string | null; body: Record<string, unknown> }[] = [];
    const account = "synthetic-account";
    const refreshed = accessToken(account);
    const first = accessToken("original-account");
    let grants = 0;
    let refreshes = 0;
    let deny = false;
    let returnTool = false;
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      if (url.origin === "https://auth.openai.com") {
        if (url.pathname === "/api/accounts/deviceauth/usercode") {
          return Response.json({ device_auth_id: "private-device-id", user_code: "TEST-CODE", interval: 0 });
        }
        if (url.pathname === "/api/accounts/deviceauth/token") {
          return Response.json({ authorization_code: "synthetic-callback-code", code_verifier: "synthetic-code-verifier" });
        }
        if (url.pathname === "/oauth/token") {
          if (!(init?.body instanceof URLSearchParams)) throw new Error("expected form-encoded grant");
          if (init.body.get("grant_type") === "refresh_token") {
            refreshes++;
            expect(init.body.get("refresh_token")).toBe("synthetic-refresh-one");
            return Response.json({ access_token: refreshed, refresh_token: "synthetic-refresh-two", expires_in: 3600 });
          }
          expect(init.body.get("grant_type")).toBe("authorization_code");
          expect(init.body.get("code")).toBe("synthetic-callback-code");
          grants++;
          return Response.json({
            access_token: grants === 1 ? first : refreshed,
            refresh_token: "synthetic-refresh-one",
            expires_in: grants === 1 ? 0 : 3600,
          });
        }
      }
      expect(url.href).toBe("https://chatgpt.com/backend-api/codex/responses");
      const headers = new Headers(init?.headers);
      expect(headers.get("originator")).toBe("joi");
      expect(init?.redirect).toBe("error");
      const data = init?.body;
      if (typeof data !== "string" && !(data instanceof Uint8Array)) throw new Error("expected Codex request body");
      const body = typeof data === "string" ? data : zstdDecompressSync(data).toString();
      requests.push({
        account: headers.get("chatgpt-account-id"), authorization: headers.get("authorization"),
        body: JSON.parse(body) as Record<string, unknown>,
      });
      if (deny) return new Response(JSON.stringify({ message: "private-provider-error" }), { status: 401 });
      return codexResponse("OK", returnTool);
    });
    vi.stubGlobal("fetch", fetch);
    try {
      const { attemptId } = logins.start("desktop-session", "device_code");
      const completed = await vi.waitFor(() => {
        const result = logins.status("desktop-session", attemptId);
        expect(result.status).toBe("completed");
        if (result.status !== "completed") throw new Error("OAuth pending");
        return result.source;
      }, { timeout: 4000 });
      expect(completed, completed.reasonCode).toMatchObject({ kind: "codex", status: "READY", accessMode: "coding-plan", protocol: "openai" });
      expect(JSON.stringify(completed)).not.toMatch(/synthetic-|private-device-id|TEST-CODE|credentialRef/u);
      const pin = { sourceId: completed.sourceId, sourceRevisionId: completed.activeSourceRevisionId, modelId: completed.activeModel.id, modelRevisionId: completed.activeModel.revisionId };
      const { model, models, thinkingLevel } = await new RepositoryPiConfiguredModelResolver({ credentials, repository }).resolve(pin);
      expect(model.api).toBe("openai-codex-responses");
      expect(model.id).toBe("gpt-6.1-sol");
      expect(thinkingLevel).toBe("high");
      const result = await models.completeSimple(model, { messages: [{ role: "user", content: "A normal Joi turn", timestamp: Date.now() }] }, {
        ...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
      });
      expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "OK" }));
      expect(grants).toBe(1);
      expect(refreshes).toBe(1);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request).toMatchObject({ account, authorization: `Bearer ${refreshed}`, body: { model: "gpt-6.1-sol", reasoning: { effort: "high" }, store: false, stream: true } });
      }
      expect(requests[0]?.body.tools).toBeUndefined();
      expect((await sources.list())[0]?.codexAccount).toBeUndefined();
      expect(await sources.list(true)).toMatchObject([{ codexAccount: { maskedAccount: "••••ount", plan: "Plus" } }]);
      expect(JSON.stringify(await sources.list(true))).not.toContain(account);

      const messages: Message[] = [
        { role: "system", content: "Use the provided tool.", timestamp: 1, toolsAdded: [{ name: "fixture_tool", description: "Returns a fixture", parameters: Type.Object({}) }] },
        { role: "user", content: "Run the fixture tool", timestamp: 2 },
      ];
      returnTool = true;
      const call = await models.completeSimple(model, { messages });
      expect(call.stopReason).toBe("toolUse");
      expect(call.content).toContainEqual(expect.objectContaining({ type: "toolCall", id: "call_test|fc_test", name: "fixture_tool", arguments: {} }));
      const requestInput = requests.at(-1)?.body.input as { type: string; tools?: unknown }[] | undefined;
      expect(requestInput?.find(({ type }) => type === "additional_tools")?.tools)
        .toContainEqual(expect.objectContaining({ type: "function", name: "fixture_tool" }));
      returnTool = false;
      const continuation = await models.completeSimple(model, { messages: [...messages, call, {
        role: "toolResult", toolCallId: "call_test|fc_test", toolName: "fixture_tool",
        content: [{ type: "text", text: "fixture complete" }], isError: false, timestamp: 3,
      }] });
      expect(continuation.stopReason).toBe("stop");
      expect(requests.at(-1)?.body.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "function_call", id: "fc_test", call_id: "call_test" }),
        expect.objectContaining({ type: "function_call_output", call_id: "call_test" }),
      ]));
      const firstCredential = await credentialRecords.read(model.provider);
      expect(firstCredential).toMatchObject({ type: "oauth", version: 2 });
      expect(Buffer.from(firstCredential?.encryptedBlob ?? []).toString()).not.toContain("synthetic-refresh-two");
      await expect(sources.update(pin.sourceId, { apiKey: "must-not-replace-oauth" })).rejects.toMatchObject({ code: "codex_oauth_required" });

      deny = true;
      const denied = await sources.validate(pin.sourceId);
      expect(denied).toMatchObject({ status: "NEEDS_AUTH", reasonCode: "auth_failed" });
      expect(denied.lastError).toBeUndefined();
      deny = false;
      await sources.update(pin.sourceId, { modelId: "gpt-5.6-sol", thinkingEffort: "low" });
      const retry = logins.start("desktop-session", "device_code", pin.sourceId);
      const reconnected = await vi.waitFor(() => {
        const result = logins.status("desktop-session", retry.attemptId);
        if (result.status !== "completed") throw new Error("OAuth pending");
        return result.source;
      }, { timeout: 4000 });
      expect(reconnected).toMatchObject({ sourceId: pin.sourceId, status: "READY", activeModel: { id: "gpt-5.6-sol", thinkingEffort: "low" } });
      expect(requests.at(-1)?.body).toMatchObject({ model: "gpt-5.6-sol", reasoning: { effort: "low" } });
      expect(reconnected.activeSourceRevisionId).not.toBe(pin.sourceRevisionId);
      expect(await sources.list()).toHaveLength(1);
      expect(await credentialRecords.read(model.provider)).toBeNull();
      await sources.delete(pin.sourceId);
      expect(await credentialRecords.list()).toEqual([]);
      expect(database.transaction((connection) => connection.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
    } finally {
      await logins.close();
      vi.unstubAllGlobals();
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
