import { HttpError, readJson, sendJson, sessionToken, stringField } from "../http-core.js";
import { exact, pattern, type RouteContext, type RouteDefinition } from "../route-types.js";
async function service(ctx: RouteContext) {
  const session = await ctx.dependencies.auth.authenticate(sessionToken(ctx.request));
  if (session.kind !== 'desktop') throw new HttpError('desktop_required', '仅电脑端可导出文件。', 403);
  if (!ctx.dependencies.resultExports) throw new HttpError('export_unavailable', '导出暂不可用。', 503);
  return ctx.dependencies.resultExports;
}
export const RESULT_EXPORT_ROUTES: RouteDefinition[] = [
  { auth: 'write', id: 'POST /api/v1/result-exports', match: exact('POST', '/api/v1/result-exports'), handle: async ctx => {
    const exports = await service(ctx); const body = await readJson(ctx.request);
    const format = stringField(body, 'format');
    if (format !== 'pdf' && format !== 'png') throw new HttpError('export_invalid', '导出格式无效。', 400);
    sendJson(ctx.response, 202, await exports.create({ goalId: stringField(body, 'goalId'), format, digest: stringField(body, 'digest'), idempotencyKey: stringField(body, 'idempotencyKey') }));
  } },
  { auth: 'read', id: 'GET /api/v1/result-exports/:id', match: pattern('GET', /^\/api\/v1\/result-exports\/([\w-]+)$/), handle: async (ctx, match) => {
    const result = await (await service(ctx)).get((match as RegExpExecArray)[1] ?? '');
    if (!result) throw new HttpError('export_not_found', '未找到导出任务。', 404);
    sendJson(ctx.response, 200, result);
  } },
  { auth: 'write', id: 'POST /api/v1/result-exports/:id/open', match: pattern('POST', /^\/api\/v1\/result-exports\/([\w-]+)\/open$/), handle: async (ctx, match) => {
    const exports = await service(ctx); const body = await readJson(ctx.request);
    await exports.open((match as RegExpExecArray)[1] ?? '', body.reveal === true);
    sendJson(ctx.response, 200, { opened: true });
  } },
];
