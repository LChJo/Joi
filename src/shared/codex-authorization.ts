import type { CodexLoginMethod } from "./joi.js";

export const CODEX_AUTHORIZATION_WINDOW = "joi-codex-authorization";

export function isCodexAuthorizationUrl(value: string, method?: CodexLoginMethod): boolean {
  const url = URL.parse(value);
  if (url?.origin !== "https://auth.openai.com" || url.username !== "" || url.password !== "" || url.hash !== "") return false;
  return (method !== "device_code" && url.pathname === "/oauth/authorize")
    || (method !== "browser" && url.pathname === "/codex/device" && url.search === "");
}
