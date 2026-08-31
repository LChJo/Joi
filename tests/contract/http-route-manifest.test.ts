import { AUTHENTICATED_ROUTES, PUBLIC_ROUTES, ROUTE_MANIFEST } from "../../src/main/interfaces/http/routes/index.js";

/**
 * Golden route surface. Any added, removed or renamed route must update this
 * list deliberately — the manifest is the single enumerable source of the API.
 */
const GOLDEN_ROUTES = [
  "GET /api/v1/health",
  "GET /api/v1/auth/status",
  "GET /api/v1/lives/:lifeId/artifacts/:artifactId/:mode",
  "POST /api/v1/auth/bootstrap",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/setup",
  "GET /api/v1/auth/session",
  "GET /api/v1/auth/sessions",
  "GET /api/v1/model-sources",
  "GET /api/v1/joi",
  "GET /api/v1/joi/runtime",
  "GET /api/v1/joi/messages",
  "GET /api/v1/joi/activity",
  "GET /api/v1/joi/home-feed",
  "GET /api/v1/work",
  "GET /api/v1/partners",
  "GET /api/v1/engines",
  "GET /api/v1/engines/:engine/skills",
  "GET /api/v1/system/pick-directory",
  "GET /api/v1/scenario-packs",
  "GET /api/v1/scenarios",
  "GET /api/v1/workbenches",
  "GET /api/v1/workbenches/:workbenchId/agents",
  "GET /api/v1/workbenches/:workbenchId/agents/:agentId/conversation",
  "POST /api/v1/workbenches/:workbenchId/artifacts/:artifactId/open",
  "DELETE /api/v1/workbenches/:workbenchId/agents/:agentId",
  "GET /api/v1/workbenches/:workbenchId",
  "PATCH /api/v1/workbenches/:workbenchId",
  "POST /api/v1/workbenches/:workbenchId/workspace/bind",
  "POST /api/v1/workbenches/:workbenchId/workspace/rebuild",
  "GET /api/v1/workbench-change-requests",
  "POST /api/v1/workbench-change-requests/:requestId/decision",
  "POST /api/v1/workbenches",
  "POST /api/v1/scenario-packs/:packId/install",
  "POST /api/v1/scenarios/:scenarioId/partners",
  "POST /api/v1/partners",
  "POST /api/v1/partners/:partnerId/test-model",
  "POST /api/v1/partners/:partnerId/prompt/reveal",
  "PATCH /api/v1/partners/:partnerId",
  "DELETE /api/v1/partners/:partnerId",
  "POST /api/v1/partners/:partnerId/duplicate",
  "GET /api/v1/partners/:partnerId/knowledge",
  "POST /api/v1/partners/:partnerId/knowledge",
  "DELETE /api/v1/partners/:partnerId/knowledge/:docId",
  "GET /api/v1/partners/:partnerId/memory",
  "GET /api/v1/partners/:partnerId/instances",
  "POST /api/v1/joi/messages",
  "POST /api/v1/joi/messages/:inputId/clarify",
  "POST /api/v1/joi/messages/:inputId/cancel",
  "POST /api/v1/joi/messages/:inputId/dismiss",
  "POST /api/v1/joi/messages/:inputId/close-historical-review",
  "POST /api/v1/joi/messages/:inputId/retry",
  "POST /api/v1/joi/attachments",
  "POST /api/v1/model-sources",
  "PUT /api/v1/model-sources/order",
  "POST /api/v1/model-sources/:sourceId/validate",
  "PATCH /api/v1/model-sources/:sourceId",
  "DELETE /api/v1/model-sources/:sourceId",
  "POST /api/v1/auth/logout",
  "POST /api/v1/auth/logout-all",
  "POST /api/v1/auth/password",
  "GET /api/v1/remote",
  "POST /api/v1/remote",
  "POST /api/v1/remote/pairings",
  "DELETE /api/v1/remote/devices/:deviceId",
  "ANY /api/v1/lives* (legacy_life_read_only guard)",
  "GET /api/v1/lives",
  "GET /api/v1/lives/:lifeId",
  "GET /api/v1/lives/:lifeId/deletion-impact",
  "GET /api/v1/lives/:lifeId/primary-agent",
  "GET /api/v1/lives/:lifeId/events",
  "GET /api/v1/lives/:lifeId/activity",
  "GET /api/v1/lives/:lifeId/(continuity|affairs|todos|alarms|memories|schedules|delegations)",
  "GET /api/v1/lives/:lifeId/expressions",
  "GET /api/v1/agents",
  "GET /api/v1/interactions",
  "POST /api/v1/interactions/:interactionId/answer",
  "POST /api/v1/interactions/:interactionId/resume-authorization",
  "POST /api/v1/agents",
  "GET /api/v1/agents/:agentConnectionId/deletion-impact",
  "DELETE /api/v1/agents/:agentConnectionId",
  "POST /api/v1/agents/:agentConnectionId/(refresh|rotate-token|disable|enable)",
  "POST /api/v1/runtime/emergency-stop",
  "GET /api/v1/diagnostics",
  "GET /api/v1/diagnostics/export",
  "GET /api/v1/settings",
  "POST /api/v1/settings",
  "GET /api/v1/backups",
  "POST /api/v1/backups",
  "POST /api/v1/backups/:backupId/restore",
  "POST /api/v1/backups/manifest",
] as const;

describe("HTTP route manifest", () => {
  it("matches the golden API surface exactly", () => {
    expect(ROUTE_MANIFEST).toEqual([...GOLDEN_ROUTES]);
  });

  it("keeps every authenticated route uniquely identified and classified", () => {
    const ids = AUTHENTICATED_ROUTES.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const route of AUTHENTICATED_ROUTES) {
      expect(["read", "write"]).toContain(route.auth);
    }
    expect(AUTHENTICATED_ROUTES.find((route) => route.id === "POST /api/v1/partners/:partnerId/prompt/reveal")?.auth).toBe("write");
    expect(AUTHENTICATED_ROUTES.find((route) => route.id === "POST /api/v1/workbenches/:workbenchId/artifacts/:artifactId/open")?.auth).toBe("write");
    expect(PUBLIC_ROUTES.length).toBe(6);
  });
});
