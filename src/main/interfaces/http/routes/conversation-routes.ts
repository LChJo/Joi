import { AuthError } from "../../../application/auth/auth-service.js";
import { HttpError, readJson, sendJson, sessionToken, stringField } from "../http-core.js";
import { exact, pattern, type RouteContext, type RouteDefinition } from "../route-types.js";
import type { GitCommandInput } from "../../../../shared/conversations.js";
import type { AnswerUserQuestionInput } from "../../../../shared/user-questions.js";
import { isConversationPiExtensions } from "../../../../shared/conversations.js";
import { streamConversation } from "../conversation-stream.js";

function service(ctx: RouteContext) {
  if (ctx.dependencies.conversations === undefined) throw new HttpError("conversation_unavailable", "Conversations are unavailable.",503);
  return ctx.dependencies.conversations;
}
async function desktop(ctx: RouteContext) {
  if ((await ctx.dependencies.auth.authenticate(sessionToken(ctx.request))).kind !== "desktop") throw new AuthError("desktop_required","Workspace files and Git are available on this computer only.",403);
}
function workspace(ctx: RouteContext) {
  if (ctx.dependencies.conversationWorkspace === undefined) throw new HttpError("conversation_workspace_unavailable","Workspace unavailable.",503);
  return ctx.dependencies.conversationWorkspace;
}
function strings(body: Record<string,unknown>,key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some(v => typeof v !== "string")) throw new HttpError("request_field_invalid",`${key} must be a string list.`,400);
  return value as string[];
}
function questionAnswer(body: Record<string,unknown>): AnswerUserQuestionInput {
  if (typeof body.version !== "number" || !Number.isInteger(body.version) || body.version < 1
    || body.useDefault !== undefined && typeof body.useDefault !== "boolean"
    || body.text !== undefined && typeof body.text !== "string") throw new HttpError("question_answer_invalid","The answer is invalid.",400);
  return {version:body.version,...(typeof body.text === "string" ? {text:body.text} : {}),
    ...(typeof body.useDefault === "boolean" ? {useDefault:body.useDefault} : {}),
    ...(body.selectedOptionIds === undefined ? {} : {selectedOptionIds:strings(body,"selectedOptionIds")})};
}
export const CONVERSATION_ROUTES: RouteDefinition[] = [
  { auth: "write",id: "POST /api/v1/conversations/:id/questions/:questionId/resume",match: pattern("POST",/^\/api\/v1\/conversations\/([^/]+)\/questions\/([^/]+)\/resume$/),handle: async (ctx,match) => {
    const resume = service(ctx).resumeQuestion;
    if (resume === undefined) throw new HttpError("question_unavailable","Question recovery is unavailable.",503);
    const [,id,questionId] = match as RegExpExecArray;
    sendJson(ctx.response,202,await resume.call(service(ctx),decodeURIComponent(id ?? ""),decodeURIComponent(questionId ?? "")));
  } },
  { auth: "write",id: "POST /api/v1/conversations/:id/questions/:questionId/answer",match: pattern("POST",/^\/api\/v1\/conversations\/([^/]+)\/questions\/([^/]+)\/answer$/),handle: async (ctx,match) => {
    const body = await readJson(ctx.request);
    const answer = service(ctx).answerQuestion;
    if (answer === undefined) throw new HttpError("question_unavailable","Questions are unavailable.",503);
    const [,id,questionId] = match as RegExpExecArray;
    sendJson(ctx.response,200,await answer.call(service(ctx),decodeURIComponent(id ?? ""),decodeURIComponent(questionId ?? ""),questionAnswer(body)));
  } },
  { auth: "write",id: "POST /api/v1/joi/goals/:id/questions/:questionId/answer",match: pattern("POST",/^\/api\/v1\/joi\/goals\/([^/]+)\/questions\/([^/]+)\/answer$/),handle: async (ctx,match) => {
    const body = await readJson(ctx.request);
    if (ctx.dependencies.userQuestions === undefined) throw new HttpError("question_unavailable","Questions are unavailable.",503);
    const [,id,questionId] = match as RegExpExecArray;
    sendJson(ctx.response,200,await ctx.dependencies.userQuestions.answer({kind:"GOAL",id:decodeURIComponent(id ?? "")},decodeURIComponent(questionId ?? ""),questionAnswer(body)));
  } },
  { auth: "read",id: "GET /api/v1/conversations",match: exact("GET","/api/v1/conversations"),handle: async ctx => sendJson(ctx.response,200,await service(ctx).list(ctx.url.searchParams.get("archived") === "true")) },
  { auth: "write",id: "POST /api/v1/conversations",match: exact("POST","/api/v1/conversations"),handle: async ctx => {
    const body = await readJson(ctx.request);
    if (body.subagentsEnabled !== undefined && typeof body.subagentsEnabled !== "boolean") throw new HttpError("conversation_selection_invalid","Subagents must be enabled or disabled.",400);
    if (body.piExtensions !== undefined && !isConversationPiExtensions(body.piExtensions)) throw new HttpError("conversation_selection_invalid","Pi extension selection is invalid.",400);
    for (const key of ["modelId","modelIdOverride","cwd","workspaceRef","revision"]) if (body[key] !== undefined) throw new HttpError("conversation_override_forbidden","Conversation configuration must use Settings and the bound workbench.",400);
    sendJson(ctx.response,202,await service(ctx).send({ conversationId: stringField(body,"conversationId"),workbenchId: stringField(body,"workbenchId"),
      requestId: stringField(body,"requestId"),text: stringField(body,"text"),partnerId: stringField(body,"partnerId"),networkId: stringField(body,"networkId"),
      ...(body.subagentsEnabled === undefined ? {} : { subagentsEnabled: body.subagentsEnabled }),
      ...(body.piExtensions === undefined ? {} : { piExtensions: body.piExtensions }),
      skills: strings(body,"skills"),attachmentIds: strings(body,"attachmentIds") }));
  } },
  { auth: "read",id: "GET /api/v1/conversations/:id",match: pattern("GET",/^\/api\/v1\/conversations\/([^/]+)$/),handle: async (ctx,match) => sendJson(ctx.response,200,await service(ctx).get(decodeURIComponent(((match as RegExpExecArray)[1] ?? "")))) },
  { auth: "read",id: "GET /api/v1/conversations/:id/stream",match: pattern("GET",/^\/api\/v1\/conversations\/([^/]+)\/stream$/),handle: (ctx,match) => streamConversation(ctx,decodeURIComponent(((match as RegExpExecArray)[1] ?? ""))) },
  { auth: "write",id: "POST /api/v1/conversations/:id/turns/:turnId/fork",match: pattern("POST",/^\/api\/v1\/conversations\/([^/]+)\/turns\/([^/]+)\/fork$/),handle: async (ctx,match) => {
    const conversations = service(ctx);
    if (conversations.fork === undefined) throw new HttpError("conversation_unavailable","Conversation forks are unavailable.",503);
    const [,id,turnId] = match as RegExpExecArray;
    const body = await readJson(ctx.request);
    sendJson(ctx.response,201,await conversations.fork(decodeURIComponent(id ?? ""),decodeURIComponent(turnId ?? ""),stringField(body,"conversationId")));
  } },
  { auth: "write",id: "PUT /api/v1/conversations/:id/title",match: pattern("PUT",/^\/api\/v1\/conversations\/([^/]+)\/title$/),handle: async (ctx,match) => {
    const body = await readJson(ctx.request);
    sendJson(ctx.response,200,await service(ctx).rename(decodeURIComponent(((match as RegExpExecArray)[1] ?? "")),stringField(body,"title")));
  } },
  { auth: "read",id: "GET /api/v1/conversations/:id/history",match: pattern("GET",/^\/api\/v1\/conversations\/([^/]+)\/history$/),handle: async (ctx,match) => {
    const page = service(ctx).page;if (page === undefined) throw new HttpError("conversation_unavailable","History pagination is unavailable.",503);
    sendJson(ctx.response,200,await page.call(service(ctx),decodeURIComponent(((match as RegExpExecArray)[1] ?? "")),ctx.url.searchParams.get("cursor") ?? undefined,Number(ctx.url.searchParams.get("limit") ?? 50)));
  } },
  { auth: "read",id: "GET /api/v1/conversations/:id/events",match: pattern("GET",/^\/api\/v1\/conversations\/([^/]+)\/events$/),handle: async (ctx,match) => {
    const events = service(ctx).events;if (events === undefined) throw new HttpError("conversation_unavailable","Conversation updates are unavailable.",503);
    sendJson(ctx.response,200,await events.call(service(ctx),decodeURIComponent(((match as RegExpExecArray)[1] ?? "")),ctx.url.searchParams.get("cursor") ?? undefined));
  } },
  { auth: "write",id: "POST /api/v1/conversations/:id/children/:childId/cancel",match: pattern("POST",/^\/api\/v1\/conversations\/([^/]+)\/children\/([^/]+)\/cancel$/),handle: async (ctx,match) => {
    const cancel = service(ctx).cancelChild;if (cancel === undefined) throw new HttpError("conversation_unavailable","Child cancellation is unavailable.",503);
    const [,id,child] = match as RegExpExecArray;await cancel.call(service(ctx),decodeURIComponent(id ?? ""),decodeURIComponent(child ?? ""));sendJson(ctx.response,200,{ canceled: true });
  } },
  { auth: "write",id: "POST /api/v1/conversations/:id/archive",match: pattern("POST",/^\/api\/v1\/conversations\/([^/]+)\/archive$/),handle: async (ctx,match) => {
    await service(ctx).archive(decodeURIComponent(((match as RegExpExecArray)[1] ?? "")));sendJson(ctx.response,200,{ changed: true });
  } },
  { auth: "write",id: "POST /api/v1/conversations/:id/restore",match: pattern("POST",/^\/api\/v1\/conversations\/([^/]+)\/restore$/),handle: async (ctx,match) => {
    await service(ctx).restore(decodeURIComponent(((match as RegExpExecArray)[1] ?? "")));sendJson(ctx.response,200,{ changed: true });
  } },
  { auth: "write",id: "DELETE /api/v1/conversations/:id",match: pattern("DELETE",/^\/api\/v1\/conversations\/([^/]+)$/),handle: async (ctx,match) => {
    await service(ctx).delete(decodeURIComponent(((match as RegExpExecArray)[1] ?? "")));sendJson(ctx.response,200,{ changed: true });
  } },
  { auth: "write",id: "POST /api/v1/conversations/:id/stop",match: pattern("POST",/^\/api\/v1\/conversations\/([^/]+)\/stop$/),handle: async (ctx,match) => {
    await service(ctx).stop(decodeURIComponent(((match as RegExpExecArray)[1] ?? ""))); sendJson(ctx.response,200,{ stopped: true });
  } },
  { auth: "read",id: "GET /api/v1/conversation-inheritance/:workbenchId",match: pattern("GET",/^\/api\/v1\/conversation-inheritance\/([^/]+)$/),handle: async (ctx,match) => {
    sendJson(ctx.response,200,await service(ctx).inheritance(decodeURIComponent(((match as RegExpExecArray)[1] ?? "")),ctx.url.searchParams.get("partnerId") ?? "joi-chat",ctx.url.searchParams.get("networkId") ?? ""));
  } },
  { auth: "write",id: "POST /api/v1/conversation-workbenches",match: exact("POST","/api/v1/conversation-workbenches"),handle: async ctx => {
    await desktop(ctx);
    if (ctx.dependencies.quickWorkbench === undefined || ctx.dependencies.directoryPicker === undefined) throw new HttpError("workbench_workspace_unavailable","Directory selection is unavailable.",503);
    const root = await ctx.dependencies.directoryPicker();
    if (root === null) throw new HttpError("workbench_workspace_selection_canceled","Directory selection canceled.",409);
    sendJson(ctx.response,201,await ctx.dependencies.quickWorkbench(root));
  } },
  { auth: "read",id: "GET /api/v1/conversation-workspaces/:workbenchId/:view",match: pattern("GET",/^\/api\/v1\/conversation-workspaces\/([^/]+)\/(git|diff|files|file)$/),handle: async (ctx,match) => {
    await desktop(ctx);
    const [,id,view] = match as RegExpExecArray;
    const wb = decodeURIComponent(id ?? ""),p = ctx.url.searchParams.get("path") ?? "";
    const port = workspace(ctx);
    sendJson(ctx.response,200,view === "git" ? await port.status(wb) : view === "diff" ? await port.diff(wb,p,ctx.url.searchParams.get("staged") === "true") : view === "file" ? await port.file(wb,p) : await port.files(wb,p));
  } },
  { auth: "write",id: "POST /api/v1/conversation-workspaces/:workbenchId/open",match: pattern("POST",/^\/api\/v1\/conversation-workspaces\/([^/]+)\/open$/),handle: async (ctx,match) => {
    await desktop(ctx);
    const body = await readJson(ctx.request);
    if (body.mode !== "OPEN" && body.mode !== "REVEAL") throw new HttpError("workspace_file_action_invalid","Choose a supported file action.",400);
    await workspace(ctx).open(decodeURIComponent((match as RegExpExecArray)[1] ?? ""),stringField(body,"path"),body.mode);
    sendJson(ctx.response,200,{ opened: true });
  } },
  { auth: "write",id: "POST /api/v1/conversation-workspaces/:workbenchId/git",match: pattern("POST",/^\/api\/v1\/conversation-workspaces\/([^/]+)\/git$/),handle: async (ctx,match) => {
    await desktop(ctx);
    if (ctx.dependencies.conversationGit === undefined) throw new HttpError("conversation_git_unavailable","Git unavailable.",503);
    const body = await readJson(ctx.request);
    sendJson(ctx.response,202,await ctx.dependencies.conversationGit.submit(decodeURIComponent(((match as RegExpExecArray)[1] ?? "")),{
      action: stringField(body,"action") as GitCommandInput["action"],requestId: stringField(body,"requestId"),
      ...(body.paths === undefined ? {} : { paths: strings(body,"paths") }),...(body.message === undefined ? {} : { message: stringField(body,"message") }),
      ...(body.branch === undefined ? {} : { branch: stringField(body,"branch") }),
    }));
  } },
  { auth: "read",id: "GET /api/v1/conversation-git-commands/:id",match: pattern("GET",/^\/api\/v1\/conversation-git-commands\/([^/]+)$/),handle: async (ctx,match) => {
    await desktop(ctx);
    if (ctx.dependencies.conversationGit === undefined) throw new HttpError("conversation_git_unavailable","Git unavailable.",503);
    sendJson(ctx.response,200,await ctx.dependencies.conversationGit.get(decodeURIComponent(((match as RegExpExecArray)[1] ?? ""))));
  } },
];
