export const ANTIGRAVITY_AUTHORIZATION_WINDOW = "joi-antigravity-authorization";
export const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";

export function isAntigravityAuthorizationUrl(value: string): boolean {
  const url = URL.parse(value);
  return url?.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth"
    && url.username === "" && url.password === "" && url.hash === "";
}
