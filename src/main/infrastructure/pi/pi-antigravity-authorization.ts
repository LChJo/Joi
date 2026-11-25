import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import type { SubscriptionAuthorizationPort, ModelSourceOAuthCredential, SubscriptionLoginStageEvent } from "../../application/ports/model-source-ports.js";
import { ANTIGRAVITY_REDIRECT_URI } from "../../../shared/antigravity-authorization.js";
import { antigravityHeaders, requestAntigravity } from "./antigravity-http.js";
import { resolveAntigravityOAuthClient } from "./antigravity-oauth-client.js";
import { fetchAntigravityAccount } from "./antigravity-userinfo.js";
import { subscriptionLoginReasonCode } from "../../application/ports/runtime-diagnostics.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_URL = new URL(ANTIGRAVITY_REDIRECT_URI);
const SCOPES = ["aicode", "cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"]
  .map((scope) => `https://www.googleapis.com/auth/${scope}`);
const SCOPE_PREFIX = "https://www.googleapis.com/auth/";
const REQUIRED_SCOPES = ["aicode", "cloud-platform", "cclog", "experimentsandconfigs"];

interface OAuthClient { clientId: string; clientSecret: string }

/** Short scope names as granted; undefined when the response carried no scope list. */
function shortScopes(scope: string | undefined): string[] | undefined {
  if (typeof scope !== "string" || scope.trim() === "") return undefined;
  return [...new Set(scope.split(/\s+/u).filter((name) => name !== "")
    .map((name) => (name.startsWith(SCOPE_PREFIX) ? name.slice(SCOPE_PREFIX.length) : name)))];
}

async function exchange(client: OAuthClient, parameters: Record<string, string>, signal: AbortSignal,
  previous?: OAuthCredential): Promise<{ credential: OAuthCredential; scope?: string }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST", redirect: "error", signal,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...parameters, client_id: client.clientId, client_secret: client.clientSecret }).toString(),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 400 || response.status === 401 ? "401 OAuth credential rejected" : `OAuth HTTP ${String(response.status)}`);
  }
  const data = await response.json().catch(() => { throw new Error("OAuth response invalid"); }) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown };
  const refresh = data.refresh_token ?? previous?.refresh;
  if (typeof data.access_token !== "string" || data.access_token.length === 0 || typeof refresh !== "string" || refresh.length === 0
    || typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new Error("401 OAuth credential invalid");
  }
  const credential: OAuthCredential = { ...previous, type: "oauth", access: data.access_token, refresh, expires: Date.now() + data.expires_in * 1000 - 300_000 };
  return { credential, ...(typeof data.scope === "string" ? { scope: data.scope } : {}) };
}

async function discoverProject(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
  if (typeof credential.projectId === "string" && credential.projectId.length > 0) return credential;
  const response = await requestAntigravity("/v1internal:loadCodeAssist", {
    method: "POST", redirect: "error", signal,
    headers: { ...antigravityHeaders(), authorization: `Bearer ${credential.access}` },
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
  refresh: async (credential, signal) => {
    const { credential: refreshed, scope } = await exchange(resolveAntigravityOAuthClient(), {
      grant_type: "refresh_token", refresh_token: credential.refresh,
    }, signal, credential);
    // A refresh response that carries scopes silently updates the stored list; nothing here may
    // alter refresh behavior, so identity fields simply ride along and failures stay as before.
    const granted = shortScopes(scope);
    return { ...refreshed, ...(granted === undefined ? {} : { scopes: granted }) };
  },
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
    const stage = (event: SubscriptionLoginStageEvent): void => { input.onStage?.(event); };
    const client = resolveAntigravityOAuthClient();
    stage({ stage: "client_credentials", outcome: "ok" });
    input.onFacts?.({ clientSource: client.source });
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
      let listening: "loopback" | "manual";
      try {
        listening = await new Promise<"loopback" | "manual">((resolve, reject) => {
          server.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "EADDRINUSE" || error.code === "EACCES") resolve("manual");
            else reject(error);
          });
          this.listenForCallback(server, () => resolve("loopback"));
        });
      } catch (error) {
        stage({ stage: "callback_listener", outcome: "failed", reasonCode: "listener_failed" });
        throw error;
      }
      stage({ stage: "callback_listener", outcome: listening === "manual" ? "fallback" : "ok",
        ...(listening === "manual" ? { reasonCode: "callback_listener_manual" } : {}) });
      input.signal.throwIfAborted();
      const params = new URLSearchParams({ client_id: client.clientId, response_type: "code", redirect_uri: ANTIGRAVITY_REDIRECT_URI,
        scope: SCOPES.join(" "), code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256", state, access_type: "offline", prompt: "consent" });
      input.showBrowser(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
      stage({ stage: "browser_open", outcome: "ok" });
      const manual = input.waitForCallback(signal).then((value) => {
        const callback = new URL(value);
        if (callback.origin + callback.pathname !== ANTIGRAVITY_REDIRECT_URI || callback.searchParams.get("state") !== state) {
          throw new Error("antigravity_callback_invalid");
        }
        return callback.searchParams.get("code") ?? "";
      });
      let code: string;
      try {
        code = await Promise.race([received, manual]);
      } catch (error) {
        stage({ stage: "callback_received", outcome: "failed", reasonCode: subscriptionLoginReasonCode(error) });
        throw error;
      }
      stage({ stage: "callback_received", outcome: "ok" });
      manualController.abort();
      input.signal.throwIfAborted();
      let exchanged: Awaited<ReturnType<typeof exchange>>;
      try {
        exchanged = await exchange(client, { code, grant_type: "authorization_code", redirect_uri: ANTIGRAVITY_REDIRECT_URI, code_verifier: verifier }, input.signal);
      } catch (error) {
        stage({ stage: "token_exchange", outcome: "failed", reasonCode: subscriptionLoginReasonCode(error) });
        throw error;
      }
      stage({ stage: "token_exchange", outcome: "ok" });
      const granted = shortScopes(exchanged.scope);
      const missing = granted === undefined ? [] : REQUIRED_SCOPES.filter((required) => !granted.includes(required));
      input.onFacts?.({
        ...(granted === undefined ? {} : { grantedScopes: granted }),
        ...(missing.length > 0 ? { missingScopes: missing } : {}),
      });
      stage(granted === undefined
        ? { stage: "scope_check", outcome: "skipped", reasonCode: "scope_unreported" }
        : missing.length > 0
          ? { stage: "scope_check", outcome: "fallback", reasonCode: "scope_missing" }
          : { stage: "scope_check", outcome: "ok" });
      let credential = exchanged.credential;
      if (typeof credential.projectId === "string" && credential.projectId.length > 0) {
        stage({ stage: "project_discovery", outcome: "skipped" });
      } else {
        try {
          credential = await discoverProject(credential, input.signal);
        } catch (error) {
          stage({ stage: "project_discovery", outcome: "failed", reasonCode: subscriptionLoginReasonCode(error) });
          throw error;
        }
        stage({ stage: "project_discovery", outcome: "ok" });
      }
      // Account identity is diagnostic information only: an unavailable endpoint never blocks sign-in.
      const account = await fetchAntigravityAccount(credential.access, input.signal);
      stage(account.email === undefined
        ? { stage: "userinfo", outcome: "failed", reasonCode: "userinfo_unavailable" }
        : { stage: "userinfo", outcome: "ok" });
      if (account.email !== undefined) input.onFacts?.({ accountEmail: account.email });
      return {
        ...credential,
        ...(granted === undefined ? {} : { scopes: granted }),
        ...(account.email === undefined ? {} : { accountEmail: account.email }),
      };
    } finally {
      manualController.abort(); input.signal.removeEventListener("abort", abort); abort();
    }
  }
}
