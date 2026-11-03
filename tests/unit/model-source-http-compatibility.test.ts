import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import type { CredentialStore } from "@earendil-works/pi-ai";

import type { ModelSourceRecord } from "../../src/main/application/ports/model-source-ports.js";
import { createModelSource } from "../../src/main/domain/model-sources/model-source.js";
import { PiModelSourceValidator } from "../../src/main/infrastructure/pi/pi-model-source-validator.js";
import { RepositoryPiConfiguredModelResolver } from "../../src/main/infrastructure/pi/pi-configured-model-resolver.js";
import { createModelSourceHttpFetch, withModelSourceHttpTransport } from "../../src/main/infrastructure/pi/model-source-http-transport.js";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";

const credentials: CredentialStore = {
  read: () => Promise.resolve({ type: "api_key", key: "fake-lan-token" }), list: () => Promise.resolve([]),
  modify: () => Promise.resolve(undefined), delete: () => Promise.resolve(),
};

function source(baseUrl: string, protocol: "anthropic" | "openai"): ModelSourceRecord {
  return {
    baseUrl, local: true, order: 0, primary: true,
    source: createModelSource({
      createdAt: "2026-10-27T00:00:00.000Z", credentialRef: "joi-source:lan", credentialVersion: 1,
      displayName: "Disposable LAN proxy", kind: "generic-openai", protocol, modelCapability: "custom-unverified-tools",
      modelId: "deepseek-flash", modelRevisionId: "model-lan", sourceId: "lan", sourceRevisionId: "source-lan",
    }),
  };
}

function sse(protocol: "anthropic" | "openai"): string {
  const events = protocol === "anthropic" ? [
    { type: "message_start", message: { id: "msg_lan", type: "message", role: "assistant", model: "deepseek-flash", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ] : [
    { type: "response.output_item.added", output_index: 0, item: { id: "msg_lan", type: "message", role: "assistant", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
    { type: "response.completed", response: { id: "resp_lan", status: "completed", output: [] } },
  ];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

async function withServer(handle: (request: IncomingMessage, response: ServerResponse) => void, run: (origin: string) => Promise<void>) {
  const server = createServer(handle);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
  }
}

describe("custom model sources over a case-sensitive HTTP proxy", () => {
  it.each(["anthropic", "openai"] as const)("validates and runs %s with the same compatible transport", async protocol => {
    const outcomes: number[] = [];
    await withServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const names = request.rawHeaders.filter((_, index) => index % 2 === 0);
        let status = 200;
        if (!names.includes("Content-Length") || request.headers["content-length"] !== String(Buffer.concat(chunks).length)) status = 400;
        else if (!names.includes("Authorization") || request.headers.authorization !== "Bearer fake-lan-token") status = 401;
        outcomes.push(status);
        response.writeHead(status, { "content-type": status === 200 ? "text/event-stream" : "application/json" });
        response.end(status === 200 ? sse(protocol) : status === 401 ? JSON.stringify({ error: "unauthorized: Bearer LAN key required" }) : "");
      });
    }, async origin => {
      const record = source(origin + (protocol === "openai" ? "/v1" : "/"), protocol);
      const validator = new PiModelSourceValidator({ credentials, clock: { now: () => new Date("2026-10-27T00:00:00.000Z") } });
      const result = await validator.validate(record);
      expect(result).toMatchObject({ status: "READY" });
      if (protocol === "anthropic") expect(result).toHaveProperty("anthropicAuthMode", "bearer");
      Object.assign(record, result);
      record.source.status = "READY";
      const resolved = await new RepositoryPiConfiguredModelResolver({ credentials, repository: { get: () => Promise.resolve(record) } }).resolve({
        sourceId: "lan", sourceRevisionId: "source-lan", modelId: "deepseek-flash", modelRevisionId: "model-lan",
      });
      const context = { messages: [{ role: "user" as const, content: "Reply with OK.", timestamp: 1 }] };
      expect((await resolved.models.completeSimple(resolved.model, context)).stopReason).toBe("stop");
      expect((await resolved.models.complete(resolved.model, context)).stopReason).toBe("stop");
      expect(outcomes).toEqual(protocol === "anthropic" ? [401, 200, 200, 200] : [200, 200, 200]);
    });
  });
});

describe("model source HTTP transport boundaries", () => {
  it("keeps the transport scoped to explicit local and LAN addresses", () => {
    const originalFetch = globalThis.fetch;
    const api = anthropicMessagesApi();
    for (const url of ["https://models.example.test/", "https://169.254.169.254/", "http://localhost/", "https://10.0.0.1.example.test/"]) {
      expect(withModelSourceHttpTransport(api, url)).toBe(api);
      expect(() => createModelSourceHttpFetch(url)).toThrow();
    }
    for (const url of ["http://127.0.0.1/", "http://10.0.0.1/", "https://172.16.0.1/", "https://192.168.1.1/"]) {
      expect(withModelSourceHttpTransport(api, url)).not.toBe(api);
    }
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("computes UTF-8 framing and removes a caller's conflicting transfer headers", async () => {
    let validFraming = false;
    await withServer((request, response) => {
      validFraming = request.headers["content-length"] === String(Buffer.byteLength("中文"))
        && request.headers["transfer-encoding"] === undefined;
      request.resume();
      response.writeHead(204).end();
    }, async origin => {
      const response = await createModelSourceHttpFetch(origin)(origin, {
        method: "POST", body: "中文", headers: { "content-length": "999", "transfer-encoding": "chunked" },
      });
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(validFraming).toBe(true);
    });
  });

  it.each([400, 403, 500])("returns HTTP %s without retrying a model request", async status => {
    let calls = 0;
    await withServer((_request, response) => { calls++; response.writeHead(status).end("synthetic error"); }, async origin => {
      const response = await createModelSourceHttpFetch(origin)(origin, { method: "POST", body: "{}" });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("synthetic error");
      expect(calls).toBe(1);
    });
  });

  it("delivers SSE chunks before the response ends", async () => {
    let finish: () => void = () => { throw new Error("response not started"); };
    await withServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      finish = () => { response.end("data: last\n\n"); };
    }, async origin => {
      const response = await createModelSourceHttpFetch(origin)(origin);
      const reader = response.body?.getReader();
      expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: first\n\n");
      finish();
      expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("data: last\n\n");
      expect((await reader?.read())?.done).toBe(true);
    });
  });

  it.each(["gzip", "deflate", "br"] as const)("decodes %s responses for SDK consumers", async encoding => {
    const compress = encoding === "gzip" ? gzipSync : encoding === "br" ? brotliCompressSync : deflateSync;
    const body = compress("data: synthetic\n\n");
    await withServer((_request, response) => {
      response.writeHead(200, { "content-encoding": encoding, "content-length": String(body.length) }).end(body);
    }, async origin => {
      const response = await createModelSourceHttpFetch(origin)(origin);
      expect(await response.text()).toBe("data: synthetic\n\n");
      expect(response.headers.has("content-encoding")).toBe(false);
      expect(response.headers.has("content-length")).toBe(false);
    });
  });

  it("rejects cross-origin redirects before sending credentials to another listener", async () => {
    let destinationCalls = 0;
    await withServer((_request, response) => { destinationCalls++; response.end(); }, async destination => {
      await withServer((_request, response) => { response.writeHead(307, { location: destination }).end(); }, async origin => {
        const fetch = createModelSourceHttpFetch(origin);
        await expect(fetch(origin, { headers: { authorization: "Bearer fake-lan-token" } })).rejects.toMatchObject({ code: "model_source_redirect_cross_origin" });
        await expect(fetch(destination, { headers: { authorization: "Bearer fake-lan-token" } })).rejects.toMatchObject({ code: "model_source_redirect_cross_origin" });
        expect(destinationCalls).toBe(0);
      });
    });
  });

  it("preserves method, body and auth through a same-origin 307", async () => {
    const seen: string[] = [];
    await withServer((request, response) => {
      seen.push(`${request.method ?? ""}:${request.url ?? ""}:${request.headers.authorization ?? ""}`);
      request.resume();
      if (request.url === "/start") response.writeHead(307, { location: "/finish" }).end();
      else response.end("OK");
    }, async origin => {
      const response = await createModelSourceHttpFetch(origin)(origin + "/start", { method: "POST", body: "{}", headers: { authorization: "Bearer fake-lan-token" } });
      expect(await response.text()).toBe("OK");
      expect(response.redirected).toBe(true);
      expect(response.url).toBe(origin + "/finish");
      expect(seen).toEqual(["POST:/start:Bearer fake-lan-token", "POST:/finish:Bearer fake-lan-token"]);
    });
  });

  it.each([false, true])("aborts and closes the socket with headers received=%s", async sendHeaders => {
    let started = () => { /* Assigned by the request-start promise. */ };
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    let closed = () => { /* Assigned by the socket-close promise. */ };
    const socketClosed = new Promise<void>(resolve => { closed = resolve; });
    await withServer((_request, response) => {
      response.on("close", closed);
      if (sendHeaders) { response.writeHead(200); response.write("first"); }
      started();
    }, async origin => {
      const controller = new AbortController();
      const pending = createModelSourceHttpFetch(origin)(origin, { signal: controller.signal });
      await requestStarted;
      if (sendHeaders) {
        const response = await pending;
        const reading = response.text();
        const rejected = expect(reading).rejects.toThrow();
        controller.abort();
        await rejected;
      } else {
        const rejected = expect(pending).rejects.toThrow();
        controller.abort();
        await rejected;
      }
      await socketClosed;
    });
  });
});
