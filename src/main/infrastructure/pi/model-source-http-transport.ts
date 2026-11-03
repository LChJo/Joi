import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable, pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { ProviderStreams } from "@earendil-works/pi-ai";

import { DomainError } from "../../domain/errors.js";
import { isLanModelSourceAddress } from "./model-source-network-policy.js";

const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function compatibleEndpoint(value: string): boolean {
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:")
    && (url.hostname === "127.0.0.1" || isLanModelSourceAddress(url.hostname))
    && url.username === "" && url.password === "";
}

function assertSameOrigin(url: URL, origin: string): void {
  if (url.origin !== origin || url.username !== "" || url.password !== "") {
    throw new DomainError("model_source_redirect_cross_origin", "Model source redirects cannot change origin.");
  }
}

function send(url: URL, method: string, headers: Headers, body: Buffer | undefined, signal: AbortSignal): Promise<IncomingMessage> {
  const wireHeaders: Record<string, string> = Object.fromEntries(headers);
  delete wireHeaders.authorization;
  delete wireHeaders["content-type"];
  delete wireHeaders["content-length"];
  delete wireHeaders["transfer-encoding"];
  delete wireHeaders.host;
  delete wireHeaders.connection;
  delete wireHeaders["accept-encoding"];
  // Keep framing and authentication names intact on the wire for case-sensitive LAN forwarders.
  wireHeaders.Host = url.host;
  wireHeaders.Connection = "close";
  wireHeaders["Accept-Encoding"] = "identity";
  if (headers.has("authorization")) wireHeaders.Authorization = headers.get("authorization") ?? "";
  if (headers.has("content-type")) wireHeaders["Content-Type"] = headers.get("content-type") ?? "";
  if (body !== undefined) wireHeaders["Content-Length"] = String(body.length);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method, headers: wireHeaders, signal, agent: false,
    }, resolve);
    request.on("error", reject);
    request.end(body);
  });
}

function responseFrom(incoming: IncomingMessage, url: URL, redirected: boolean, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const status = incoming.statusCode ?? 500;
  const noBody = method === "HEAD" || status === 204 || status === 205 || status === 304;
  let stream: Readable = incoming;
  if (!noBody) {
    const encoding = headers.get("content-encoding");
    const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
      : encoding === "br" ? createBrotliDecompress() : undefined;
    if (decoder !== undefined) {
      stream = decoder;
      pipeline(incoming, decoder, () => { /* Stream consumers receive transport errors through the body. */ });
      headers.delete("content-encoding");
      headers.delete("content-length");
    }
  } else incoming.resume();
  const response = new Response(noBody ? null : Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status, statusText: incoming.statusMessage ?? "", headers,
  });
  Object.defineProperties(response, { url: { value: url.href }, redirected: { value: redirected } });
  return response;
}

export function createModelSourceHttpFetch(baseUrl: string): typeof fetch {
  const origin = new URL(baseUrl).origin;
  if (!compatibleEndpoint(baseUrl)) throw new DomainError("model_source_url_prohibited", "Model source URL is not allowed.");
  return async (input, init) => {
    const request = new Request(input, init);
    let url = new URL(request.url);
    assertSameOrigin(url, origin);
    request.signal.throwIfAborted();
    let body = request.body === null ? undefined : Buffer.from(await request.arrayBuffer());
    let method = request.method;
    const headers = new Headers(request.headers);
    for (let redirects = 0; ; redirects++) {
      request.signal.throwIfAborted();
      const incoming = await send(url, method, headers, body, request.signal);
      const status = incoming.statusCode ?? 500;
      const location = incoming.headers.location;
      if (!redirectStatuses.has(status) || location === undefined || request.redirect === "manual") {
        return responseFrom(incoming, url, redirects > 0, method);
      }
      incoming.destroy();
      const target = new URL(location, url);
      assertSameOrigin(target, origin);
      if (request.redirect === "error" || redirects >= 20) throw new TypeError("Model source redirect rejected.");
      if (status === 303 && method !== "HEAD" || (status === 301 || status === 302) && method === "POST") {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      url = target;
    }
  };
}

/** Apply one transport at the provider boundary so probes and all runtime consumers share it. */
export function withModelSourceHttpTransport(api: ProviderStreams, baseUrl: string): ProviderStreams {
  if (!compatibleEndpoint(baseUrl)) return api;
  const fetch = createModelSourceHttpFetch(baseUrl);
  const wrapped: ProviderStreams = {
    ...api,
    stream: (model, context, options) => api.stream(model, context, { ...options, fetch: options?.fetch ?? fetch }),
    streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options, fetch: options?.fetch ?? fetch }),
  };
  const fetchDeferred = api.fetchDeferred?.bind(api);
  const cancelDeferred = api.cancelDeferred?.bind(api);
  if (fetchDeferred !== undefined) wrapped.fetchDeferred = (model, handle, options) => fetchDeferred(model, handle, { ...options, fetch: options?.fetch ?? fetch });
  if (cancelDeferred !== undefined) wrapped.cancelDeferred = (model, handle, options) => cancelDeferred(model, handle, { ...options, fetch: options?.fetch ?? fetch });
  return wrapped;
}
