import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { CodexAuthorizationPort } from "../../application/ports/model-source-ports.js";
import { isCodexAuthorizationUrl } from "../../../shared/codex-authorization.js";

export class PiCodexAuthorization implements CodexAuthorizationPort {
  async authorize(input: Parameters<CodexAuthorizationPort["authorize"]>[0]) {
    const host = process.env.PI_OAUTH_CALLBACK_HOST ?? "";
    if (input.method === "browser" && !["", "127.0.0.1", "::1", "localhost"].includes(host)) {
      throw new Error("codex_oauth_callback_host_invalid");
    }
    const oauth = openaiCodexProvider().auth.oauth;
    if (oauth === undefined) throw new Error("codex_oauth_unavailable");
    return oauth.login({
      signal: input.signal,
      prompt: (prompt) => {
        if (prompt.type === "select" && prompt.options.some(({ id }) => id === input.method)) {
          return Promise.resolve(input.method);
        }
        if (prompt.type === "manual_code") return input.waitForCallback(prompt.signal ?? input.signal);
        return Promise.reject(new Error("codex_oauth_prompt_unsupported"));
      },
      notify: (event) => {
        if (event.type === "auth_url" && isCodexAuthorizationUrl(event.url, "browser")) input.showBrowser(event.url);
        if (event.type === "device_code" && isCodexAuthorizationUrl(event.verificationUri, "device_code")) {
          input.showDeviceCode(event.verificationUri, event.userCode);
        }
      },
    }, { agentName: "joi" });
  }
}
