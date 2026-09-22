import { validateStatisticsQuery } from "../../../application/statistics/statistics-service.js";
import { HttpError, sendJson } from "../http-core.js";
import { exact, type RouteDefinition } from "../route-types.js";

export const STATISTICS_ROUTES: RouteDefinition[] = [{
  auth: "read", id: "GET /api/v1/statistics", match: exact("GET", "/api/v1/statistics"),
  handle: (ctx) => {
    if (ctx.dependencies.statistics === undefined) throw new HttpError("statistics_unavailable", "Statistics are unavailable.", 503);
    const allowed = new Set(["from", "to", "timeZone", "workbenchId", "modelKey", "purpose"]);
    for (const key of ctx.url.searchParams.keys()) if (!allowed.has(key) || ctx.url.searchParams.getAll(key).length !== 1) throw new HttpError("statistics_query_invalid", "Statistics filters are invalid.", 400);
    const query = validateStatisticsQuery(Object.fromEntries(ctx.url.searchParams));
    sendJson(ctx.response, 200, ctx.dependencies.statistics.query(query));
  },
}];
