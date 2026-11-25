export const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_LOCATION_DENIED = "LOCATION_NOT_ELIGIBLE";
const ENDPOINTS = [ANTIGRAVITY_ENDPOINT, "https://cloudcode-pa.googleapis.com"];
const ERROR_BODY_LIMIT = 8_192;
export { antigravityHeaders } from "./antigravity-oauth-client.js";

/** Retains only explicit, recognized eligibility facts from the provider's error body. */
export async function safeAntigravityHttpError(response: Response): Promise<string> {
  const message = `Antigravity HTTP ${String(response.status)}`;
  if (response.status !== 400 && response.status !== 403) {
    await response.body?.cancel().catch(() => undefined);
    return message;
  }
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return message;
  try {
    const decoder = new TextDecoder();
    let body = "", bytes = 0;
    for (;;) {
      const { done,value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > ERROR_BODY_LIMIT) return message;
      body += decoder.decode(value,{ stream: true });
    }
    const payload = JSON.parse(body + decoder.decode()) as { error?: { message?: unknown; details?: unknown } } | null;
    const detail = payload?.error;
    const explicitReason = Array.isArray(detail?.details) && detail.details.some((entry: unknown) =>
      entry !== null && typeof entry === "object" && (entry as { reason?: unknown }).reason === ANTIGRAVITY_LOCATION_DENIED);
    const explicitMessage = typeof detail?.message === "string"
      && /\bLOCATION_NOT_ELIGIBLE\b|not currently available in your location|user location is not supported for the API use/iu.test(detail.message);
    return explicitReason || explicitMessage ? `${message}: ${ANTIGRAVITY_LOCATION_DENIED}` : message;
  } catch {
    return message;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Only pre-stream transport/server failures may move a request to the other Google endpoint. */
export async function requestAntigravity(path: "/v1internal:loadCodeAssist" | "/v1internal:streamGenerateContent?alt=sse", init: RequestInit): Promise<Response> {
  for (const [index, endpoint] of ENDPOINTS.entries()) {
    try {
      const response = await globalThis.fetch(endpoint + path, { ...init, redirect: "error" });
      if (response.status < 500 || index === ENDPOINTS.length - 1) return response;
      await response.body?.cancel();
    } catch {
      if (init.signal?.aborted) init.signal.throwIfAborted();
      if (index === ENDPOINTS.length - 1) throw new Error("Antigravity connection failed");
    }
  }
  throw new Error("Antigravity connection failed");
}
