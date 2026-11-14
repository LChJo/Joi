import { ApiError, DigitalLifeApi, type RequestOptions } from "./api";
import { randomUuid } from "./random-uuid";
import type { RemoteCommand } from "../shared/remote";
import type { SendConversationInput } from "../shared/conversations";

export interface RemoteConversationTransport {
  command<T>(command: RemoteCommand, signal?: AbortSignal): Promise<T>;
}

interface Catalog { workbenches: unknown[];networks: unknown[];partners: unknown[] }

/** Maps the shared conversation UI to the paired command allowlist. */
export class RemoteConversationApi extends DigitalLifeApi {
  constructor(private readonly transport: RemoteConversationTransport) { super(""); }
  override readonly conversationAttachments: boolean = false;
  override watchConversation(): (() => void) | undefined { return undefined; }

  override async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(path,"https://remote.invalid");
    const method = options.method ?? "GET",requestId = randomUuid();
    const read = (command: RemoteCommand) => this.transport.command<T>(command,options.signal);
    const catalogKey = new Map([["/api/v1/workbenches","workbenches"],["/api/v1/model-sources","networks"],["/api/v1/partners","partners"]]).get(url.pathname) as keyof Catalog | undefined;
    if (method === "GET" && catalogKey !== undefined) {
      const catalog = await this.transport.command<Catalog>({ kind: "conversation.catalog",requestId },options.signal);
      return { items: catalog[catalogKey] } as T;
    }
    if (url.pathname === "/api/v1/conversations") {
      if (method === "GET") return read({ kind: "conversation.list",requestId,archived: url.searchParams.get("archived") === "true" });
      if (method === "POST") return read({ kind: "conversation.send",requestId,input: options.body as unknown as SendConversationInput });
    }
    const skills = /^\/api\/v1\/engines\/([^/]+)\/skills$/.exec(url.pathname);
    if (method === "GET" && skills !== null) return read({ kind: "conversation.skills",requestId,engine: decodeURIComponent(skills[1] ?? "") });
    const inheritance = /^\/api\/v1\/conversation-inheritance\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && inheritance !== null) return read({ kind: "conversation.inheritance",requestId,workbenchId: decodeURIComponent(inheritance[1] ?? ""),partnerId: url.searchParams.get("partnerId") ?? "joi-chat",networkId: url.searchParams.get("networkId") ?? "" });
    const match = /^\/api\/v1\/conversations\/([^/]+)(?:\/(title|history|events|stop|archive|restore|children\/([^/]+)\/cancel))?$/.exec(url.pathname);
    if (match !== null) {
      const conversationId = decodeURIComponent(match[1] ?? ""),action = match[2];
      if (method === "GET" && action === undefined) return read({ kind: "conversation.get",requestId,conversationId });
      if (method === "DELETE" && action === undefined) return read({ kind: "conversation.delete",requestId,conversationId });
      if (method === "PUT" && action === "title") return read({ kind: "conversation.rename",requestId,conversationId,title: typeof options.body?.title === "string" ? options.body.title : "" });
      if (method === "GET" && (action === "history" || action === "events")) return read({ kind: `conversation.${action}`,requestId,conversationId,...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") ?? "" } : {}) });
      if (method === "POST" && (action === "stop" || action === "archive" || action === "restore")) return read({ kind: `conversation.${action}`,requestId,conversationId });
      if (method === "POST" && match[3] !== undefined) return read({ kind: "conversation.cancelChild",requestId,conversationId,childId: decodeURIComponent(match[3]) });
    }
    throw new ApiError("remote_operation_forbidden","This operation is unavailable remotely.",403);
  }
}
