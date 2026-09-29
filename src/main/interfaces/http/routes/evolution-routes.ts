import { HttpError, readJson, sendJson, stringField } from "../http-core.js";
import { pattern, type RouteDefinition, type RouteContext, type RouteMatch } from "../route-types.js";

function service(ctx: RouteContext) {
  if (ctx.dependencies.evolution === undefined) throw new HttpError("evolution_unavailable", "Evolution is unavailable.", 503);
  return ctx.dependencies.evolution;
}
const id = (match: RouteMatch) => decodeURIComponent((match as RegExpExecArray)[1] ?? "");
export const EVOLUTION_ROUTES: RouteDefinition[] = [
  { auth: "read", id: "GET /api/v1/workbenches/:workbenchId/evolution", match: pattern("GET", /^\/api\/v1\/workbenches\/([^/]+)\/evolution$/),
    handle: (ctx, match) => { sendJson(ctx.response, 200, service(ctx).status(id(match))); } },
  { auth: "write", id: "PATCH /api/v1/workbenches/:workbenchId/evolution", match: pattern("PATCH", /^\/api\/v1\/workbenches\/([^/]+)\/evolution$/),
    handle: async (ctx, match) => {
      const body = await readJson(ctx.request);
      if (typeof body.dailyCallLimit !== "number" || Object.keys(body).some((key) => key !== "dailyCallLimit")) throw new HttpError("evolution_budget_invalid", "Daily call limit is invalid.", 400);
      sendJson(ctx.response, 200, service(ctx).configure(id(match), body.dailyCallLimit));
    } },
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
