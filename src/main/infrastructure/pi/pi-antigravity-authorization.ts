import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { SubscriptionAuthorizationPort, ModelSourceOAuthCredential } from "../../application/ports/model-source-ports.js";
import { ANTIGRAVITY_REDIRECT_URI } from "../../../shared/antigravity-authorization.js";
import { ANTIGRAVITY_HEADERS, requestAntigravity } from "./antigravity-http.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_URL = new URL(ANTIGRAVITY_REDIRECT_URI);
const SCOPES = ["aicode", "cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"]
  .map((scope) => `https://www.googleapis.com/auth/${scope}`);

interface OAuthClient { id: string; secret: string }

function oauthClient(): OAuthClient {
  const id = process.env.JOI_ANTIGRAVITY_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.JOI_ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error("antigravity_oauth_client_unconfigured");
  return { id, secret };
}

async function exchange(client: OAuthClient, parameters: Record<string, string>, signal: AbortSignal, previous?: OAuthCredential): Promise<OAuthCredential> {
  const response = await fetch(TOKEN_URL, {
    method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...parameters, client_id: client.id, client_secret: client.secret }).toString(),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 400 || response.status === 401 ? "401 OAuth credential rejected" : `OAuth HTTP ${String(response.status)}`);
  }
  const data = await response.json().catch(() => { throw new Error("OAuth response invalid"); }) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  const refresh = data.refresh_token ?? previous?.refresh;
  if (typeof data.access_token !== "string" || data.access_token.length === 0 || typeof refresh !== "string" || refresh.length === 0
    || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new Error("401 OAuth credential invalid");
  }
  return { ...previous, type: "oauth", access: data.access_token, refresh, expires: Date.now() + data.expires_in * 1000 - 300_000 };
}

async function discoverProject(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
  if (typeof credential.projectId === "string" && credential.projectId.length > 0) return credential;
  const response = await requestAntigravity("/v1internal:loadCodeAssist", {
    method: "POST", redirect: "error", signal,
    headers: { ...ANTIGRAVITY_HEADERS, authorization: `Bearer ${credential.access}` },
    body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" } }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Antigravity HTTP ${String(response.status)}`); }
  const data = await response.json().catch(() => { throw new Error("Antigravity project response invalid"); }) as { cloudaicompanionProject?: string | { id?: string } };
  const projectId = typeof data.cloudaicompanionProject === "string" ? data.cloudaicompanionProject : data.cloudaicompanionProject?.id;
  // Consumer accounts can omit a Cloud project. Persist one opaque fallback across token refreshes.
  return { ...credential, projectId: projectId === "" ? randomUUID() : projectId ?? randomUUID() };
}

export const antigravityOAuth: OAuthAuth = {
  name: "Antigravity", isSubscription: true,
  login: () => Promise.reject(new Error("Use desktop subscription sign-in")),
  refresh: async (credential, signal) => discoverProject(await exchange(oauthClient(), {
    grant_type: "refresh_token", refresh_token: credential.refresh,
  }, signal, credential), signal),
  toAuth: (credential) => {
    if (typeof credential.projectId !== "string" || !credential.projectId) return Promise.reject(new Error("401 OAuth credential missing project"));
    return Promise.resolve({ apiKey: JSON.stringify({ token: credential.access, projectId: credential.projectId }) });
  },
};

export class PiAntigravityAuthorization implements SubscriptionAuthorizationPort {
  constructor(private readonly listenForCallback: (server: Server, listening: () => void) => void = (server, listening) => {
    server.listen(Number(CALLBACK_URL.port), "127.0.0.1", listening);
  }) {}

  async authorize(input: Parameters<SubscriptionAuthorizationPort["authorize"]>[0]): Promise<ModelSourceOAuthCredential> {
    if (input.method !== "browser") throw new Error("antigravity_login_method_invalid");
    input.signal.throwIfAborted();
    const client = oauthClient();
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    let settle: (code: string) => void = () => undefined;
    const received = new Promise<string>((resolve) => { settle = resolve; });
    const server = createServer((request, response) => {
      const url = URL.parse(request.url ?? "", CALLBACK_URL);
      const valid = request.method === "GET" && request.headers.host === CALLBACK_URL.host
        && url?.pathname === CALLBACK_URL.pathname && url.searchParams.getAll("code").length === 1
        && Boolean(url.searchParams.get("code")) && url.searchParams.getAll("state").length === 1
        && url.searchParams.get("state") === state;
      response.writeHead(valid ? 200 : 400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "default-src 'none'", "referrer-policy": "no-referrer" });
      response.end(valid ? "Antigravity sign-in received. Return to Joi." : "Invalid sign-in callback.");
      if (valid) settle(url.searchParams.get("code") ?? "");
    });
    const abort = () => { server.closeAllConnections(); server.close(); };
    input.signal.addEventListener("abort", abort, { once: true });
    const manualController = new AbortController();
    const signal = AbortSignal.any([input.signal, manualController.signal]);
    try {
      // The validated manual callback path is available when the loopback port is occupied or reserved.
      await new Promise<void>((resolve, reject) => {
        server.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve();
          else reject(error);
        });
        this.listenForCallback(server, resolve);
      });
      input.signal.throwIfAborted();
      const params = new URLSearchParams({ client_id: client.id, response_type: "code", redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        scope: SCOPES.join(" "), code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", state, access_type: "offline", prompt: "consent" });
      input.showBrowser(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
      const manual = input.waitForCallback(signal).then((value) => {
        const callback = new URL(value);
        if (callback.origin + callback.pathname !== ANTIGRAVITY_REDIRECT_URI || callback.searchParams.get("state") !== state) {
          throw new Error("antigravity_callback_invalid");
        }
        return callback.searchParams.get("code") ?? "";
      });
      const code = await Promise.race([received, manual]);
      manualController.abort();
      input.signal.throwIfAborted();
      const credential = await exchange(client, { code, grant_type: "authorization_code", redirect_uri: ANTIGRAVITY_REDIRECT_URI, code_verifier: verifier }, input.signal);
      return await discoverProject(credential, input.signal);
    } finally {
      manualController.abort(); input.signal.removeEventListener("abort", abort); abort();
    }
  }
}
