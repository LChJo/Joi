/* Transport and credential doubles never access real services or user data. */
/* eslint-disable @typescript-eslint/require-await */
import type { CredentialStore } from "@earendil-works/pi-ai";

import type { ModelSourceRecord } from "../../src/main/application/ports/model-source-ports.js";
import { createModelSource } from "../../src/main/domain/model-sources/model-source.js";
import { PiModelSourceValidator } from "../../src/main/infrastructure/pi/pi-model-source-validator.js";

function record(kind: "deepseek" | "generic-openai" = "deepseek", baseUrl?: string): ModelSourceRecord {
  return {
    ...(baseUrl === undefined ? {} : { baseUrl }), local: false, order: 0, primary: true,
    source: createModelSource({
      createdAt: "2026-09-20T00:00:00.000Z", credentialRef: "joi-source:test", credentialVersion: 1,
      displayName: "Probe test", kind, modelCapability: "custom-unverified-tools", modelId: "deepseek-flash",
      modelRevisionId: "model-1", sourceId: "test", sourceRevisionId: "revision-1",
    }),
  };
}

function validator() {
  const credentials: CredentialStore = {
    read: async () => ({ type: "api_key", key: "fake-probe-key" }), list: async () => [],
    modify: async () => undefined, delete: async () => undefined,
  };
  return new PiModelSourceValidator({ clock: { now: () => new Date("2026-09-20T00:00:00.000Z") }, credentials });
}

function response(text: string, status = "completed", thinking = false) {
  const item = { id: "msg_test", type: "message", role: "assistant", content: [] };
  const events = [
    ...(thinking ? [
      { type: "response.output_item.added", output_index: 1, item: { id: "reason_test", type: "reasoning", summary: [] } },
      { type: "response.reasoning_summary_text.delta", output_index: 1, delta: "private test reasoning" },
    ] : []),
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: `response.${status}`, response: {
      id: "resp_test", status, output: [],
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("model source probe over the real Pi Responses transport", () => {
  it.each([
    record(), record("generic-openai", "https://api.deepseek.com/v1"),
  ])("disables default DeepSeek thinking so a bounded probe reaches visible text", async (source) => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("expected JSON request body");
      const payload = JSON.parse(init.body) as Record<string, unknown>;
      requests.push(payload);
      const noThinking = (payload.reasoning as { effort?: string } | undefined)?.effort === "none";
      return noThinking ? response("OK") : response("", "incomplete");
    }));

    expect(await validator().validate(source)).toMatchObject({ status: "READY" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ reasoning: { effort: "none" }, max_output_tokens: 64 });
    expect(requests[0]?.tools).toBeUndefined();
  });

  it("does not apply DeepSeek controls to unrelated or lookalike endpoints", async () => {
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("expected JSON request body");
      const payload = JSON.parse(init.body) as Record<string, unknown>;
      expect(payload.reasoning).toBeUndefined();
      return response("OK");
    });
    vi.stubGlobal("fetch", fetch);
    expect(await validator().validate(record("generic-openai", "https://api.deepseek.com.example/v1")))
      .toMatchObject({ status: "READY" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["", "completed", "empty_response"],
    [" \n\t", "completed", "empty_response"],
    ["", "incomplete", "response_truncated"],
  ])("classifies unusable responses without calling them unreachable", async (text, status, reasonCode) => {
    vi.stubGlobal("fetch", vi.fn(async () => response(text, status)));
    const result = await validator().validate(record());
    expect(result).toMatchObject({ status: "DEGRADED", reasonCode });
    expect(JSON.stringify(result)).not.toContain("minimal text response failed");
  });

  it("accepts visible text even when the provider reaches its output limit", async () => {
    const fetch = vi.fn(async () => response("O", "incomplete"));
    vi.stubGlobal("fetch", fetch);
    expect(await validator().validate(record())).toMatchObject({ status: "READY" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["completed", "incomplete"])("retries thinking-only %s output once with more room for text", async (status) => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("expected JSON request body");
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      return requests.length === 1 ? response("", status, true) : response("OK");
    }));
    expect(await validator().validate(record())).toMatchObject({ status: "READY" });
    expect(requests.map((request) => request.max_output_tokens)).toEqual([64, 1024]);
    for (const request of requests) {
      expect(request.reasoning).toEqual({ effort: "none" });
      expect(request.tools).toBeUndefined();
    }
    expect(requests[1]?.input).toEqual(requests[0]?.input);
  });

  it.each(["completed", "incomplete"])("stops after two thinking-only %s replies and exposes no reasoning", async (status) => {
    const fetch = vi.fn(async () => response("", status, true));
    vi.stubGlobal("fetch", fetch);
    const result = await validator().validate(record());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "DEGRADED", reasonCode: status === "completed" ? "empty_response" : "response_truncated" });
    expect(JSON.stringify(result)).not.toContain("private test reasoning");
  });

  it("does not retry an empty completed response without thinking", async () => {
    const fetch = vi.fn(async () => response(""));
    vi.stubGlobal("fetch", fetch);
    expect(await validator().validate(record())).toMatchObject({ reasonCode: "empty_response" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("preserves a provider error on the retry instead of treating it as a text success", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response("", "incomplete", true))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "401 Unauthorized" } }), {
        status: 401, headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetch);
    expect(await validator().validate(record())).toMatchObject({ status: "NEEDS_AUTH", reasonCode: "auth_failed" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the forced-thinking plan enabled during the larger retry", async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      if (typeof init.body !== "string") throw new Error("expected JSON request body");
      requests.push(JSON.parse(init.body) as Record<string, unknown>);
      return requests.length === 1 ? response("", "incomplete", true) : response("OK");
    }));
    expect(await validator().validate(record("generic-openai", "https://coding.dashscope.aliyuncs.com/v1")))
      .toMatchObject({ status: "READY" });
    expect(requests.map((request) => request.max_output_tokens)).toEqual([256, 1024]);
    expect(requests.map((request) => request.reasoning)).toEqual([
      { effort: "low", summary: "auto" }, { effort: "low", summary: "auto" },
    ]);
  });

  it("shares the original deadline across both attempts", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return response("", "incomplete", true);
      })
      .mockImplementationOnce(async (_url: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }));
    vi.stubGlobal("fetch", fetch);
    const result = validator().validate(record());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await result).toMatchObject({ status: "DEGRADED", reasonCode: "timeout" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
