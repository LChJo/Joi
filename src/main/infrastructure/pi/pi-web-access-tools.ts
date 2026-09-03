import { Readability } from "@mozilla/readability";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseHTML } from "linkedom";

export const PI_WEB_ACCESS_TOOL_NAMES = ["web_search", "fetch_content", "get_search_content"] as const;

const MAX_QUERY_LENGTH = 500;
const MAX_RESULTS = 10;
const MAX_RESPONSE_BYTES = 1_500_000;
const MAX_RESPONSE_CHARS = 120_000;
const MAX_PAGE_CHARS = 20_000;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MILLIS = 15_000;
const CACHE_LIMIT = 16;

interface HostAddress {
  address: string;
  family: number;
}
type FetchImplementation = typeof fetch;
type ResolveHost = (hostname: string) => Promise<HostAddress[]>;

interface WebAccessOptions {
  fetchImpl?: FetchImplementation;
  resolveHost?: ResolveHost;
  idGenerator?: () => string;
  maxResponseBytes?: number;
  requestTimeoutMillis?: number;
}

interface CachedContent {
  content: string;
  title: string;
  url: string;
}

interface SearchResult {
  snippet: string;
  title: string;
  url: string;
}

interface WebElement {
  closest(selector: string): WebElement | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): WebElement | null;
  textContent: string | null;
}

interface WebDocument {
  body: WebElement | null;
  querySelectorAll(selector: string): WebElement[];
  title: string;
}

interface ReaderResult {
  textContent?: string | null;
  title?: string | null;
}

const searchParameters = Type.Object({
  limit: Type.Optional(Type.Integer({ maximum: MAX_RESULTS, minimum: 1 })),
  query: Type.String({ maxLength: MAX_QUERY_LENGTH, minLength: 1 }),
});

const fetchParameters = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("readable"), Type.Literal("raw")])),
  url: Type.String({ maxLength: 2_048, minLength: 1 }),
});

const getContentParameters = Type.Object({
  findText: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ maximum: MAX_PAGE_CHARS, minimum: 1 })),
  offset: Type.Optional(Type.Integer({ maximum: MAX_RESPONSE_CHARS, minimum: 0 })),
  responseId: Type.String({ maxLength: 128, minLength: 1 }),
});

function textResult(text: string, details: Record<string, unknown> = {}): { content: [{ text: string; type: "text" }]; details: Record<string, unknown> } {
  return { content: [{ text, type: "text" }], details };
}

function errorResult(code: string, message: string): { content: [{ text: string; type: "text" }]; details: Record<string, unknown>; isError: true } {
  return { ...textResult(message, { code }), isError: true };
}

function boundedText(value: string, maxChars = MAX_RESPONSE_CHARS): string {
  const normalized = value.replace(/\r\n?/gu, "\n").replace(/[\t ]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}\n\n[content truncated]`;
}

function firstContentPage(content: string): { hasMore: boolean; nextOffset?: number; text: string } {
  if (content.length <= MAX_PAGE_CHARS) return { hasMore: false, text: content };
  return { hasMore: true, nextOffset: MAX_PAGE_CHARS, text: content.slice(0, MAX_PAGE_CHARS) };
}

function privateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized.includes(":")) {
    const mappedMatch = /::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
    const mapped = mappedMatch?.[1];
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
    const mappedFromHex = mappedHex === null ? undefined : (() => {
      const high = Number.parseInt(mappedHex[1] ?? "0", 16);
      const low = Number.parseInt(mappedHex[2] ?? "0", 16);
      return `${(high >> 8).toString()}.${(high & 255).toString()}.${(low >> 8).toString()}.${(low & 255).toString()}`;
    })();
    return mapped !== undefined
      ? privateAddress(mapped)
      : mappedFromHex !== undefined
        ? privateAddress(mappedFromHex)
        : normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
          || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return first === 0 || first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

async function defaultResolveHost(hostname: string): Promise<HostAddress[]> {
  const normalized = hostname.replace(/^\[|\]$/gu, "");
  const family = isIP(normalized);
  if (family !== 0) return [{ address: normalized, family }];
  return dnsLookup(normalized, { all: true });
}

async function validatePublicUrl(input: string, resolveHost: ResolveHost): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("web_url_invalid");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new Error("web_url_not_allowed");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) throw new Error("web_private_host");
  const literalHost = hostname.replace(/^\[|\]$/gu, "");
  if (isIP(literalHost) !== 0 && privateAddress(literalHost)) throw new Error("web_private_host");
  const addresses = await resolveHost(hostname);
  if (addresses.length === 0 || addresses.some((address) => privateAddress(address.address))) throw new Error("web_private_host");
  return url;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) throw new Error("web_response_too_large");
  if (response.body === null) return boundedText(await response.text());
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("web_response_too_large");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return boundedText(new TextDecoder().decode(bytes));
}

function readableContent(raw: string, contentType: string): { content: string; title: string } {
  if (!contentType.toLowerCase().includes("html")) return { content: boundedText(raw), title: "" };
  const html = parseHTML(raw) as unknown as { document: WebDocument };
  const ReadabilityConstructor = Readability as unknown as new (document: unknown) => { parse(): ReaderResult | null };
  const parsed = new ReadabilityConstructor(html.document).parse();
  const content = parsed?.textContent ?? html.document.body?.textContent ?? "";
  return { content: boundedText(content), title: boundedText(parsed?.title ?? html.document.title, 500) };
}

function unwrapSearchUrl(href: string): string {
  try {
    const url = new URL(href, "https://html.duckduckgo.com");
    const target = url.searchParams.get("uddg");
    return target === null ? url.toString() : decodeURIComponent(target);
  } catch {
    return href;
  }
}

function githubRoot(url: URL): { owner: string; repo: string } | undefined {
  if (url.hostname.toLowerCase() !== "github.com") return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => part === "." || part === "..")) return undefined;
  const owner = parts[0];
  const repo = parts[1];
  if (owner === undefined || repo === undefined) return undefined;
  return { owner, repo: repo.replace(/\.git$/u, "") };
}

export class PiWebAccessToolFactory {
  readonly #fetch: FetchImplementation;
  readonly #resolveHost: ResolveHost;
  readonly #idGenerator: () => string;
  readonly #maxResponseBytes: number;
  readonly #requestTimeoutMillis: number;
  readonly #cache = new Map<string, CachedContent>();

  constructor(options: WebAccessOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#resolveHost = options.resolveHost ?? defaultResolveHost;
    this.#idGenerator = options.idGenerator ?? (() => `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    this.#maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
    this.#requestTimeoutMillis = options.requestTimeoutMillis ?? REQUEST_TIMEOUT_MILLIS;
  }

  create(names: readonly string[]): AgentTool[] {
    return [...new Set(names)].map((name) => {
      if (name === "web_search") return this.#webSearchTool();
      if (name === "fetch_content") return this.#fetchContentTool();
      if (name === "get_search_content") return this.#getContentTool();
      throw new Error("partner_tool_not_allowed");
    });
  }

  async #request(url: URL, headers: Record<string, string> = {}): Promise<{ response: Response; url: URL }> {
    let current = url;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const response = await this.#fetch(current, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#requestTimeoutMillis),
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url: current };
      const location = response.headers.get("location");
      if (location === null) throw new Error("web_redirect_invalid");
      current = await validatePublicUrl(new URL(location, current).toString(), this.#resolveHost);
    }
    throw new Error("web_redirect_limit");
  }

  #remember(entry: CachedContent): string {
    let id = this.#idGenerator();
    while (this.#cache.has(id)) id = `${id}_1`;
    this.#cache.set(id, entry);
    while (this.#cache.size > CACHE_LIMIT) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return id;
  }

  #getContentTool(): AgentTool<typeof getContentParameters> {
    return {
      description: "Read a bounded page of content previously returned by web_search or fetch_content.",
      execute: (_toolCallId, parameters) => Promise.resolve().then(() => {
        const entry = this.#cache.get(parameters.responseId);
        if (entry === undefined) return errorResult("web_response_not_found", "The web response is no longer available; fetch it again.");
        const offset = parameters.offset ?? 0;
        const limit = parameters.limit ?? MAX_PAGE_CHARS;
        const start = parameters.findText === undefined ? offset : entry.content.indexOf(parameters.findText, offset);
        const content = start >= 0 ? entry.content.slice(start, start + limit) : "Text not found in this response.";
        return textResult(content, { responseId: parameters.responseId, title: entry.title, url: entry.url, ...(start >= 0 ? { offset: start } : {}) });
      }),
      label: "Get web content",
      name: "get_search_content",
      parameters: getContentParameters,
    };
  }

  #fetchContentTool(): AgentTool<typeof fetchParameters> {
    return {
      description: "Fetch one public HTTP(S) URL and return bounded readable text. GitHub repository roots return their public README when available.",
      execute: async (_toolCallId, parameters) => {
        try {
          const requested = await validatePublicUrl(parameters.url, this.#resolveHost);
          const github = githubRoot(requested);
          if (github !== undefined) {
            for (const branch of ["main", "master"]) {
              const readmeUrl = await validatePublicUrl(`https://raw.githubusercontent.com/${github.owner}/${github.repo}/${branch}/README.md`, this.#resolveHost);
              const result = await this.#request(readmeUrl, { accept: "text/plain" });
              if (!result.response.ok) continue;
              const content = boundedText(await readBoundedText(result.response, this.#maxResponseBytes));
              const responseId = this.#remember({ content, title: `${github.owner}/${github.repo} README`, url: parameters.url });
              const page = firstContentPage(content);
              return textResult(page.text, {
                hasMore: page.hasMore,
                ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
                responseId, title: `${github.owner}/${github.repo} README`, url: parameters.url,
              });
            }
          }
          const result = await this.#request(requested);
          if (!result.response.ok) return errorResult("web_http_error", `Web request failed with status ${result.response.status.toString()}.`);
          const raw = await readBoundedText(result.response, this.#maxResponseBytes);
          const extracted = parameters.mode === "raw" ? { content: raw, title: "" } : readableContent(raw, result.response.headers.get("content-type") ?? "");
          const responseId = this.#remember({ content: extracted.content, title: extracted.title, url: result.url.toString() });
          const page = firstContentPage(extracted.content);
          return textResult(page.text, {
            hasMore: page.hasMore,
            ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
            responseId, title: extracted.title, url: result.url.toString(),
          });
        } catch (error) {
          const code = error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : "web_request_failed";
          return errorResult(code, "Unable to read that public web address. Check the URL and try again.");
        }
      },
      label: "Fetch web content",
      name: "fetch_content",
      parameters: fetchParameters,
    };
  }

  #webSearchTool(): AgentTool<typeof searchParameters> {
    return {
      description: "Search the public web for a short research query and return titles, URLs, and snippets.",
      execute: async (_toolCallId, parameters) => {
        try {
          const query = parameters.query.trim();
          if (query.length === 0) return errorResult("web_query_invalid", "Search query cannot be empty.");
          const endpoint = await validatePublicUrl(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, this.#resolveHost);
          const result = await this.#request(endpoint, { accept: "text/html" });
          if (!result.response.ok) return errorResult("web_search_failed", "The public web search is temporarily unavailable.");
          const html = await readBoundedText(result.response, this.#maxResponseBytes);
          const parsedHtml = parseHTML(html) as unknown as { document: WebDocument };
          const { document } = parsedHtml;
          const results: SearchResult[] = [];
          for (const link of [...document.querySelectorAll("a.result__a")].slice(0, parameters.limit ?? MAX_RESULTS)) {
            const title = boundedText(link.textContent ?? "", 500);
            const url = unwrapSearchUrl(link.getAttribute("href") ?? "");
            const snippet = boundedText(link.closest(".result")?.querySelector(".result__snippet")?.textContent ?? "", 1_000);
            if (title !== "" && url !== "") results.push({ snippet, title, url });
          }
          const responseText = results.length === 0 ? "No public web results found." : results.map((item, index) => `${(index + 1).toString()}. ${item.title}\n${item.url}\n${item.snippet}`).join("\n\n");
          const responseId = this.#remember({ content: responseText, title: `Search: ${query}`, url: endpoint.toString() });
          return textResult(responseText, { query, responseId, results });
        } catch {
          return errorResult("web_search_failed", "The public web search is temporarily unavailable.");
        }
      },
      label: "Search web",
      name: "web_search",
      parameters: searchParameters,
    };
  }
}
