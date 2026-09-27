import type { JoiInboxService } from "../joi/joi-inbox-service.js";
import type { JoiHomeFeedService } from "../joi/joi-home-feed-service.js";
import type { RemoteCommand, RemoteCommandResponse, RemoteReadPage } from "../../../shared/remote.js";
import { DomainError } from "../../domain/errors.js";
import { sanitizeAgentConversationText } from "../partners/agent-conversation-presentation.js";

export interface RemoteHomeQueries {
  catalog(): Promise<unknown>;
  goal(goalId: string): Promise<unknown>;
  agents(goalId: string, cursor?: string): Promise<unknown>;
  conversation(goalId: string, agentId: string, cursor?: string): Promise<unknown>;
}

function safeResult<T>(value: T): T {
  return safeProjection(value) as T;
}

function safeProjection(value: unknown): unknown {
  if (typeof value === "string") return sanitizeAgentConversationText(value);
  if (Array.isArray(value)) return value.map(safeProjection);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeProjection(item)]));
  return value;
}

export class RemoteCommandService {
  #serial = 0;
  readonly #pages = new Map<string, { scope: string; body: string; offset: number; expires: number }>();
  constructor(private readonly dependencies: {
    homeFeed: Pick<JoiHomeFeedService, "load">;
    inbox: Pick<JoiInboxService, "accept"> & Partial<Pick<JoiInboxService, "clarify" | "retry" | "cancel" | "dismiss" | "closeHistoricalReview">>;
    queries?: RemoteHomeQueries;
    now?: () => number;
  }) {}

  release(scope: string): void {
    for (const [key, page] of this.#pages) if (page.scope === scope) this.#pages.delete(key);
  }

  async handle(command: RemoteCommand | { kind: string; requestId: string }, scope = "local"): Promise<RemoteCommandResponse> {
    const base = { kind: "response" as const, requestId: command.requestId };
    try {
      const c = command as RemoteCommand;
      const queries = this.dependencies.queries;
      if (c.kind === "read.next") return { ...base, result: this.#next(c.cursor, scope) };
      if (c.kind === "feed.get") {
        const feed = await this.dependencies.homeFeed.load();
        return { ...base, result: c.paged === true ? this.#page(feed, scope) : safeResult(feed) };
      }
      if (c.kind === "catalog.get" && queries !== undefined) return { ...base, result: this.#page(await queries.catalog(), scope) };
      if (c.kind === "goal.get" && queries !== undefined) return { ...base, result: this.#page(await queries.goal(c.goalId), scope) };
      if (c.kind === "goal.agents" && queries !== undefined) return { ...base, result: this.#page(await queries.agents(c.goalId, c.cursor), scope) };
      if (c.kind === "agent.conversation" && queries !== undefined) return { ...base, result: this.#page(await queries.conversation(c.goalId, c.agentId, c.cursor), scope) };
      if (c.kind === "message.send" && typeof c.text === "string" && typeof c.idempotencyKey === "string") {
        return { ...base, result: safeResult(await this.dependencies.inbox.accept({
          idempotencyKey: c.idempotencyKey, text: c.text.trim(),
          ...(c.workbenchId === undefined ? {} : { workbenchId: c.workbenchId }),
        })) };
      }
      if (c.kind === "message.clarify" && this.dependencies.inbox.clarify !== undefined) {
        return { ...base, result: safeResult(await this.dependencies.inbox.clarify({ inputId: c.inputId,
          ...(c.text === undefined ? {} : { text: c.text }), ...(c.workbenchId === undefined ? {} : { workbenchId: c.workbenchId }),
          ...(c.partnerId === undefined ? {} : { partnerId: c.partnerId }), ...(c.actionChoice === undefined ? {} : { actionChoice: c.actionChoice }),
          // Forwarded, not merely accepted: the repository matches these against the gate's own
          // question, and a resolution that arrives without them is refused for a card the user is
          // looking at. The desktop route has always passed them through; this one dropped them.
          ...(c.questionId === undefined ? {} : { questionId: c.questionId }),
          ...(c.questionVersion === undefined ? {} : { questionVersion: c.questionVersion }),
        })) };
      }
      if (c.kind === "message.retry" && this.dependencies.inbox.retry !== undefined) {
        return { ...base, result: safeResult(await this.dependencies.inbox.retry({ inputId: c.inputId, ...(c.text === undefined ? {} : { text: c.text }) })) };
      }
      const operation = c.kind === "message.cancel" ? this.dependencies.inbox.cancel
        : c.kind === "message.dismiss" ? this.dependencies.inbox.dismiss
          : c.kind === "message.closeHistoricalReview" ? this.dependencies.inbox.closeHistoricalReview : undefined;
      if (operation !== undefined && "inputId" in c) return { ...base, result: safeResult(await operation.call(this.dependencies.inbox, { inputId: c.inputId })) };
      return { ...base, error: { code: "remote_operation_forbidden", message: "This remote operation is not available." } };
    } catch (error) {
      return { ...base, error: { code: error instanceof DomainError ? error.code : "remote_command_failed", message: "操作未完成，请刷新后重试。" } };
    }
  }

  #page(value: unknown, scope: string): RemoteReadPage {
    const now = this.dependencies.now?.() ?? Date.now();
    for (const [key, page] of this.#pages) if (page.expires <= now) this.#pages.delete(key);
    if ([...this.#pages.values()].filter((page) => page.scope === scope).length >= 8 || this.#pages.size >= 64) {
      throw new DomainError("remote_read_busy", "Too many pending reads.");
    }
    const body = JSON.stringify(safeProjection(value));
    if (new TextEncoder().encode(body).length > 16 * 1024 * 1024) throw new DomainError("remote_read_too_large", "Read is too large.");
    const cursor = `page-${String(++this.#serial)}`;
    this.#pages.set(cursor, { scope, body, offset: 0, expires: now + 60_000 });
    return this.#next(cursor, scope);
  }

  #next(cursor: string, scope: string): RemoteReadPage {
    const page = this.#pages.get(cursor);
    if (page?.scope !== scope || page.expires <= (this.dependencies.now?.() ?? Date.now())) {
      throw new DomainError("remote_cursor_expired", "Refresh this read.");
    }
    // JSON escaping of 12k UTF-16 units stays under 96 KiB including the envelope.
    let end = Math.min(page.body.length, page.offset + 12_000);
    const last = page.body.charCodeAt(end - 1);
    if (end < page.body.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    const chunk = page.body.slice(page.offset, end);
    page.offset = end;
    if (end === page.body.length) this.#pages.delete(cursor);
    return { encoding: "json", chunk, ...(end === page.body.length ? {} : { nextCursor: cursor }) };
  }
}
