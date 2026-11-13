import type { ConversationUpdateDto } from "../../../shared/conversations.js";
import { HttpError,sessionToken } from "./http-core.js";
import type { RouteContext } from "./route-types.js";

export async function streamConversation(ctx: RouteContext,id: string): Promise<void> {
  const service = ctx.dependencies.conversations;
  if (service?.subscribe === undefined) throw new HttpError("conversation_unavailable","Conversation streaming is unavailable.",503);
  const { response } = ctx;
  let closed = false,ready = false,blocked = false;
  let pending: ConversationUpdateDto | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: () => void = () => undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;unsubscribe();if (heartbeat !== undefined) clearInterval(heartbeat);
    response.off("drain",drain);
  };
  const end = () => { cleanup();response.end(); };
  const send = (update: ConversationUpdateDto) => {
    if (closed) return;
    if (!ready || blocked) { pending = update;return; }
    blocked = !response.write(`event: conversation\ndata: ${JSON.stringify(update)}\n\n`);
    if (update.turn.status !== "QUEUED" && update.turn.status !== "RUNNING") end();
  };
  function drain() {
    blocked = false;
    const next = pending;pending = undefined;if (next !== undefined) send(next);
  }
  response.once("close",cleanup);response.on("drain",drain);
  try {
    unsubscribe = service.subscribe(id,send);
    const initial = await service.get(id),turn = initial.turns.at(-1);
    if (response.destroyed) return;
    response.writeHead(200,{ "cache-control": "no-store","content-type": "text/event-stream; charset=utf-8",connection: "keep-alive","x-accel-buffering": "no" });
    response.flushHeaders();response.socket?.setNoDelay(true);ready = true;
    const latest = pending;pending = undefined;
    if (latest !== undefined) send(latest);
    else if (turn !== undefined) send({ conversationId: id,turn,...(initial.context === undefined ? {} : { context: initial.context }) });
    else { end();return; }
    if (response.writableEnded) return;
    let checking = false;
    heartbeat = setInterval(() => {
      if (closed || checking) return;
      checking = true;
      void ctx.dependencies.auth.authenticate(sessionToken(ctx.request)).then(() => {
        if (!closed && !blocked) blocked = !response.write(": heartbeat\n\n");
      }).catch(end).finally(() => { checking = false; });
    },15_000);
    heartbeat.unref();
  } catch (error) { cleanup();throw error; }
}
