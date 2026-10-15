import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import type { ApiHandler } from "./api-handler.js";
import { readJson } from "./http-core.js";
import { isLocalePreference, type UiLocalePreference } from "../../../shared/i18n/index.js";
import { recoveryPage } from "./recovery-page.js";

interface RecoveryBackups {
  create(): Promise<{ backupId: string }>;
  list(): Promise<{ backupId: string; createdAt: string; databaseBytes: number; schemaVersion: number }[]>;
  stageRecoveryRestore(backupId: string): Promise<{ backupId: string; restartRequired: true }>;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

export function createRecoveryModeHandler(input: { backups: RecoveryBackups; requestRestart: () => void; uiLocale?: UiLocalePreference; systemLanguages?: readonly string[]; setUiLocale?: (value: UiLocalePreference) => Promise<void> }): ApiHandler {
  const nonce = randomBytes(18).toString("base64");
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && url.pathname === "/api/v1/health") {
        json(response, 200, { database: "read-only", reason: "migration_failed", status: "recovery" }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/recovery") {
        json(response, 200, { backups: await input.backups.list(), database: { mode: "read-only-recovery" }, reason: "migration_failed" }); return;
      }
      const expectedOrigin = `http://${request.headers.host ?? ""}`;
      if (request.method === "POST" && request.headers.origin !== expectedOrigin) {
        json(response, 403, { code: "origin_invalid", message: "Recovery writes require the same loopback Origin." }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/recovery/ui-locale") {
        const body = await readJson(request);
        if (!isLocalePreference(body.uiLocale)) { json(response, 400, { code: "ui_locale_invalid" }); return; }
        if (input.setUiLocale === undefined) { json(response, 503, { code: "settings_unavailable" }); return; }
        await input.setUiLocale(body.uiLocale);
        input.uiLocale = body.uiLocale;
        json(response, 200, { uiLocale: body.uiLocale }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/recovery/backups") {
        json(response, 201, await input.backups.create()); return;
      }
      const restore = /^\/api\/v1\/recovery\/backups\/([^/]+)\/restore$/.exec(url.pathname);
      if (request.method === "POST" && restore !== null) {
        const result = await input.backups.stageRecoveryRestore(decodeURIComponent(restore[1] ?? ""));
        json(response, 202, result);
        setTimeout(input.requestRestart, 50).unref();
        return;
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'`,
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(recoveryPage(nonce, input.uiLocale ?? "system", input.systemLanguages ?? [])); return;
      }
      json(response, 404, { code: "route_not_found", message: "Recovery route was not found." });
    } catch {
      json(response, 400, { code: "recovery_request_failed", message: "The recovery request could not be completed." });
    }
  };
}
