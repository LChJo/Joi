/* Credentials and transport are disposable doubles; requests never reach real services. */
/* eslint-disable @typescript-eslint/require-await */
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { ModelSourceRecord } from "../../src/main/application/ports/model-source-ports.js";
import { createModelSource } from "../../src/main/domain/model-sources/model-source.js";
import { PiModelSourceValidator } from "../../src/main/infrastructure/pi/pi-model-source-validator.js";
import { RepositoryPiConfiguredModelResolver } from "../../src/main/infrastructure/pi/pi-configured-model-resolver.js";

const credentials: CredentialStore = {
  read: async () => ({ type: "api_key", key: "fake-auth-token" }), list: async () => [],
  modify: async () => undefined, delete: async () => undefined,
};

function record(protocol: "anthropic" | "openai" = "anthropic"): ModelSourceRecord {
  return {
    baseUrl: "http://127.0.0.1:12345/", local: true, order: 0, primary: true,
    source: createModelSource({
      createdAt: "2026-10-12T00:00:00.000Z", credentialRef: "joi-source:auth-test", credentialVersion: 1,
      displayName: "Auth test", kind: "generic-openai", modelCapability: "custom-unverified-tools",
      modelId: "deepseek-flash", modelRevisionId: "model-1", protocol, sourceId: "auth-test",
      sourceRevisionId: "source-1", thinkingEffort: "xhigh",
    }),
  };
}

function textResponse(text = "OK", stopReason = "end_turn") {
  const events = [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "deepseek-flash", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

function failure(status: number) {
  return new Response(JSON.stringify({ error: { type: "authentication_error", message: `original ${String(status)} failure` } }), {
    status, headers: { "content-type": "application/json" },
  });
}

function validator() {
  return new PiModelSourceValidator({ clock: { now: () => new Date("2026-10-12T00:00:00.000Z") }, credentials });
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Anthropic authentication compatibility over the real Pi SDK", () => {
  it("proves Bearer with the same no-tool request after a 401 and returns the learned mode", async () => {
    const requests: { headers: Headers; body: unknown; signal: AbortSignal | null | undefined }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("expected JSON request body");
      requests.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) as unknown, signal: init.signal });
      return requests.length === 1 ? failure(401) : textResponse();
    }));
    const input = record();
    expect(await validator().validate(input)).toMatchObject({ status: "READY", anthropicAuthMode: "bearer" });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get("x-api-key")).toBe("fake-auth-token");
    expect(requests[0]?.headers.has("authorization")).toBe(false);
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer fake-auth-token");
    expect(requests[1]?.headers.has("x-api-key")).toBe(false);
    expect(requests[1]?.body).toEqual(requests[0]?.body);
    expect(requests[1]?.body).toMatchObject({ model: "deepseek-flash", max_tokens: 256, output_config: { effort: "xhigh" } });
    expect(requests[1]?.body).not.toHaveProperty("tools");
    expect(input).not.toHaveProperty("anthropicAuthMode");
  });

  it("keeps a working API Key source on its existing auth with one request", async () => {
    const fetch = vi.fn(async () => textResponse());
    vi.stubGlobal("fetch", fetch);
    expect(await validator().validate(record())).toEqual({ status: "READY", validatedAt: "2026-10-12T00:00:00.000Z" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the same credential for the alternate probe even if the stored key changes", async () => {
    let key = "fake-original-token";
    const mutableCredentials: CredentialStore = { ...credentials, read: async () => ({ type: "api_key", key }) };
    const requests: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      requests.push(new Headers(init.headers));
      if (requests.length === 1) { key = "fake-new-token"; return failure(401); }
      return textResponse();
    }));
    const result = await new PiModelSourceValidator({ clock: { now: () => new Date("2026-10-12T00:00:00.000Z") }, credentials: mutableCredentials }).validate(record());
    expect(result).toMatchObject({ status: "READY", anthropicAuthMode: "bearer" });
    expect(requests[1]?.get("authorization")).toBe("Bearer fake-original-token");
  });

  it.each([401, 403, 400, 404])("preserves the original 401 if Bearer fails with %s", async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(failure(401)).mockResolvedValueOnce(failure(status));
    vi.stubGlobal("fetch", fetch);
    const result = await validator().validate(record());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "NEEDS_AUTH", reasonCode: "auth_failed" });
    expect(result.error).toContain("original 401 failure");
    expect(result).not.toHaveProperty("anthropicAuthMode");
  });

  it("does not adopt Bearer merely because HTTP succeeded without visible text", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(failure(401)).mockResolvedValueOnce(textResponse(""));
    vi.stubGlobal("fetch", fetch);
    expect(await validator().validate(record())).toMatchObject({ status: "NEEDS_AUTH", reasonCode: "auth_failed" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 403, 404])("does not guess another auth scheme on %s", async (status) => {
    const fetch = vi.fn(async () => failure(status));
    vi.stubGlobal("fetch", fetch);
    expect(await validator().validate(record())).not.toHaveProperty("anthropicAuthMode");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves OpenAI 401 handling unchanged", async () => {
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => failure(401));
    vi.stubGlobal("fetch", fetch);
    expect(await validator().validate(record("openai"))).toMatchObject({ reasonCode: "auth_failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses learned Bearer directly in both validation and the configured runtime resolver", async () => {
    const input = Object.assign(record(), { anthropicAuthMode: "bearer" as const });
    input.source.status = "READY";
    const headers: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      headers.push(new Headers(init.headers));
      return textResponse();
    }));
    expect(await validator().validate(input)).toMatchObject({ status: "READY" });
    const resolved = await new RepositoryPiConfiguredModelResolver({ credentials, repository: { get: async () => input } }).resolve({
      modelId: "deepseek-flash", modelRevisionId: "model-1", sourceId: "auth-test", sourceRevisionId: "source-1",
    });
    const response = await resolved.models.completeSimple(resolved.model, { messages: [{ role: "user", content: "Reply with OK.", timestamp: 1 }] });
    expect(response.stopReason).toBe("stop");
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header.get("authorization")).toBe("Bearer fake-auth-token");
      expect(header.has("x-api-key")).toBe(false);
    }
  });

  it("keeps a failing learned Bearer source on Bearer without a reverse retry", async () => {
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => failure(401));
    vi.stubGlobal("fetch", fetch);
    expect(await validator().validate(Object.assign(record(), { anthropicAuthMode: "bearer" as const }))).toMatchObject({ reasonCode: "auth_failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const init = fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fake-auth-token");
  });

  it("shares the original deadline across the API Key and Bearer probes", async () => {
    vi.useFakeTimers();
    const probe = vi.fn(async (input: ModelSourceRecord, signal: AbortSignal) => {
      if (input.anthropicAuthMode === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 25_000));
        throw Object.assign(new Error("original 401 failure"), { status: 401 });
      }
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const pending = new PiModelSourceValidator({ clock: { now: () => new Date("2026-10-12T00:00:00.000Z") }, probe }).validate(record());
    await vi.advanceTimersByTimeAsync(25_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]?.[1]).toBe(probe.mock.calls[0]?.[1]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toMatchObject({ reasonCode: "auth_failed" });
  });
});
