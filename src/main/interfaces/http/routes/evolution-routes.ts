import { HttpError, readJson, sendJson, stringField } from "../http-core.js";
import { pattern, type RouteDefinition, type RouteContext, type RouteMatch } from "../route-types.js";

function service(ctx: RouteContext) {
  if (ctx.dependencies.evolution === undefined) throw new HttpError("evolution_unavailable", "Evolution is unavailable.", 503);
  return ctx.dependencies.evolution;
}
const id = (match: RouteMatch) => decodeURIComponent((match as RegExpExecArray)[1] ?? "");
export const EVOLUTION_ROUTES: RouteDefinition[] = [
  { auth: "read", id: "GET /api/v1/evolution", match: pattern("GET", /^\/api\/v1\/evolution$/),
    handle: (ctx) => { sendJson(ctx.response, 200, service(ctx).overview()); } },
  { auth: "write", id: "PATCH /api/v1/evolution", match: pattern("PATCH", /^\/api\/v1\/evolution$/),
    handle: async (ctx) => {
      const body = await readJson(ctx.request);
      if (Object.keys(body).length === 0 || Object.keys(body).some(key => !["enabled", "dailyCallLimit"].includes(key))
        || (body.enabled !== undefined && typeof body.enabled !== "boolean")
        || (body.dailyCallLimit !== undefined && typeof body.dailyCallLimit !== "number")) throw new HttpError("evolution_budget_invalid", "Global learning settings are invalid.", 400);
      sendJson(ctx.response, 200, service(ctx).configureGlobal({ ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.dailyCallLimit === undefined ? {} : { dailyCallLimit: body.dailyCallLimit }) }));
    } },
  { auth: "write", id: "POST /api/v1/evolution/resume", match: pattern("POST", /^\/api\/v1\/evolution\/resume$/),
    handle: (ctx) => { sendJson(ctx.response, 200, service(ctx).resumeGlobal()); } },
  { auth: "read", id: "GET /api/v1/workbenches/:workbenchId/evolution", match: pattern("GET", /^\/api\/v1\/workbenches\/([^/]+)\/evolution$/),
    handle: (ctx, match) => { sendJson(ctx.response, 200, service(ctx).status(id(match))); } },
  { auth: "write", id: "PATCH /api/v1/workbenches/:workbenchId/evolution", match: pattern("PATCH", /^\/api\/v1\/workbenches\/([^/]+)\/evolution$/),
    handle: async (ctx, match) => {
      const body = await readJson(ctx.request);
      if (Object.keys(body).length === 0 || Object.keys(body).some((key) => !["dailyCallLimit", "enabled"].includes(key))
        || (body.dailyCallLimit !== undefined && typeof body.dailyCallLimit !== "number")
        || (body.enabled !== undefined && typeof body.enabled !== "boolean")) throw new HttpError("evolution_budget_invalid", "Learning participation is invalid.", 400);
      if (typeof body.dailyCallLimit === "number") service(ctx).configure(id(match), body.dailyCallLimit);
      sendJson(ctx.response, 200, typeof body.enabled === "boolean" ? service(ctx).configureParticipation(id(match), body.enabled) : service(ctx).status(id(match)));
    } },
  { auth: "write", id: "POST /api/v1/workbenches/:workbenchId/evolution/resume", match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/evolution\/resume$/),
    handle: (ctx, match) => { sendJson(ctx.response, 200, service(ctx).resumeWorkbench(id(match))); } },
  { auth: "write", id: "POST /api/v1/workbenches/:workbenchId/evolution/rollback", match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/evolution\/rollback$/),
    handle: async (ctx, match) => { const body = await readJson(ctx.request); sendJson(ctx.response, 200, service(ctx).rollback(id(match), stringField(body, "revisionId"))); } },
  { auth: "write", id: "POST /api/v1/workbenches/:workbenchId/evolution/feedback", match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/evolution\/feedback$/),
    handle: async (ctx, match) => { const body = await readJson(ctx.request); sendJson(ctx.response, 200, service(ctx).negativeFeedback(id(match), stringField(body, "goalId"))); } },
  // Queues a real batch start that bypasses the evidence gate; it still waits for the idle slot and
  // the daily budget, so the answer is the queued status rather than a finished batch.
  { auth: "write", id: "POST /api/v1/workbenches/:workbenchId/evolution/run-now", match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/evolution\/run-now$/),
    handle: (ctx, match) => { sendJson(ctx.response, 200, service(ctx).requestRun(id(match))); } },
  // Runs a batch against a stand-in model: no provider calls, no durable writes, and the answer is
  // synchronous because a full batch takes under a second when nothing reaches the network.
  { auth: "write", id: "POST /api/v1/workbenches/:workbenchId/evolution/dry-run", match: pattern("POST", /^\/api\/v1\/workbenches\/([^/]+)\/evolution\/dry-run$/),
    handle: async (ctx, match) => {
      const dryRun = ctx.dependencies.evolutionDryRun;
      if (dryRun === undefined) throw new HttpError("evolution_dry_run_unavailable", "Evolution dry run is unavailable.", 503);
      const workbenchId = id(match);
      // The status read is the ownership check: it rejects an unknown workbench before any work starts.
      service(ctx).status(workbenchId);
      sendJson(ctx.response, 200, await dryRun.run(workbenchId));
    } },
];
