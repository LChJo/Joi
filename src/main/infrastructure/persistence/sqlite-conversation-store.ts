/* SQLite implements an asynchronous application port. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../../domain/errors.js";
import type { ConversationStore, ConversationSubmission } from "../../application/ports/conversations.js";
import type { ConversationDto, ConversationSummaryDto, ConversationTurnDto } from "../../../shared/conversations.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { PartnerSessionState } from "../../application/ports/partner-instances.js";
import { sanitizeAgentConversationText } from "../../application/partners/agent-conversation-presentation.js";

interface Database { transaction<T>(operation: (db: DatabaseSync) => T): T; }
type Row = Record<string, unknown>;
function summary(row: Row): ConversationSummaryDto {
  return { conversationId: String(row.conversation_id), workbenchId: String(row.workbench_id), title: String(row.title), updatedAt: String(row.updated_at),
    ...(typeof row.archived_at === "string" ? { archivedAt: row.archived_at } : {}),...(row.can_archive === undefined ? {} : { canArchive: row.can_archive === 1 }) };
}
function turn(row: Row): ConversationTurnDto {
  return { turnId: String(row.turn_id), text: sanitizeAgentConversationText(String(row.body)), createdAt: String(row.created_at),
    status: row.status as ConversationTurnDto["status"], config: JSON.parse(String(row.config_json)) as ConversationTurnDto["config"],
    entries: JSON.parse(String(row.entries_json)) as ConversationTurnDto["entries"], artifacts: JSON.parse(String(row.artifacts_json)) as ConversationTurnDto["artifacts"],
    ...(typeof row.error_code === "string" ? { errorCode: row.error_code } : {}) };
}
function read(db: DatabaseSync, id: string): ConversationDto | null {
  const row = db.prepare("SELECT * FROM conversations WHERE conversation_id=? AND deleted_at IS NULL").get(id);
  if (row === undefined) return null;
  const page = historyPage(db,id,undefined,50);
  const latest = db.prepare("SELECT MAX(sequence) AS sequence FROM conversation_changes WHERE conversation_id=?").get(id);
  return { ...summary(row),turns: page.items,...(page.nextCursor === null ? {} : { historyCursor: page.nextCursor }),
    eventCursor: eventCursor(id,Number(latest?.sequence ?? 0)),
    ...(typeof row.context_json === "string" ? { context: JSON.parse(row.context_json) as NonNullable<ConversationDto["context"]> } : {}),
    children: db.prepare(`SELECT child_id,status FROM conversation_subagents WHERE parent_turn_id=(SELECT turn_id FROM conversation_turns
      WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1) ORDER BY rowid LIMIT 100`).all(id)
      .map(item => ({ childId: String(item.child_id),status: item.status as NonNullable<ConversationDto["children"]>[number]["status"] })),
  };
}
function eventCursor(id: string,sequence: number): string { return `events:${id}:${String(sequence)}`; }
function cursorValue(id: string,cursor: string | undefined,kind: string): number | undefined {
  if (cursor === undefined) return undefined;
  const prefix = `${kind}:${id}:`;
  const value = cursor.slice(prefix.length);
  if (!cursor.startsWith(prefix) || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new DomainError("conversation_cursor_invalid","Conversation cursor is invalid.");
  return Number(value);
}
function historyPage(db: DatabaseSync,id: string,cursor: string | undefined,limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new DomainError("conversation_page_invalid","History page size must be between 1 and 100.");
  const before = cursorValue(id,cursor,"history");
  const rows = db.prepare(`SELECT rowid AS position,* FROM conversation_turns WHERE conversation_id=?${before === undefined ? "" : " AND rowid<?"} ORDER BY rowid DESC LIMIT ?`)
    .all(...(before === undefined ? [id,limit + 1] : [id,before,limit + 1]));
  const visible = rows.slice(0,limit).reverse();
  return { items: visible.map(turn),nextCursor: rows.length > limit ? `history:${id}:${String(visible[0]?.position)}` : null };
}
function requireConversation(db: DatabaseSync,id: string): ConversationDto {
  const value = read(db,id);
  if (value === null) throw new DomainError("conversation_not_found", "Conversation was not found.");
  return value;
}

export class SqliteConversationStore implements ConversationStore {
  readonly #sessionMessages = new Map<string,string[]>();
  constructor(private readonly database: Database) {}
  async page(id: string,cursor?: string,limit = 50) { return this.database.transaction(db => { requireConversation(db,id);return historyPage(db,id,cursor,limit); }); }
  async events(id: string,cursor?: string) { return this.database.transaction(db => {
    requireConversation(db,id);
    const after = cursorValue(id,cursor,"events") ?? 0;
    const rows = db.prepare("SELECT sequence,turn_id FROM conversation_changes WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 101").all(id,after);
    const items = rows.slice(0,100).map(row => ({ sequence: Number(row.sequence),turnId: typeof row.turn_id === "string" ? row.turn_id : null }));
    return { items,cursor: eventCursor(id,items.at(-1)?.sequence ?? after),hasMore: rows.length > 100 };
  }); }
  async context(id: string,turnId: string,context: Parameters<ConversationStore["context"]>[2]) {
    this.database.transaction(db => db.prepare(`UPDATE conversations SET context_json=? WHERE conversation_id=? AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM conversation_turns WHERE turn_id=? AND conversation_id=? AND status='RUNNING')`).run(JSON.stringify(context),id,turnId,id));
  }
  async history(id: string, beforeTurnId: string) {
    return this.database.transaction(db => {
      requireConversation(db,id);
      return db.prepare(`SELECT * FROM conversation_turns WHERE conversation_id=?
        AND rowid < (SELECT rowid FROM conversation_turns WHERE turn_id=? AND conversation_id=?) ORDER BY rowid`)
        .all(id,beforeTurnId,id).map(row => ({ ...turn(row),text: String(row.body) }));
    });
  }
  async session(id: string) {
    return this.database.transaction(db => {
      requireConversation(db,id);
      const row = db.prepare("SELECT state_json FROM conversation_execution_sessions WHERE conversation_id=?").get(id);
      if (row === undefined) return undefined;
      const stored = db.prepare("SELECT sequence,message_json FROM conversation_execution_messages WHERE conversation_id=? ORDER BY sequence").all(id);
      const messages = stored.map((message,index) => {
        if (message.sequence !== index) throw new DomainError("conversation_session_invalid","Private session history is incomplete.");
        return String(message.message_json);
      });
      this.#rememberSession(id,messages);
      return { ...JSON.parse(String(row.state_json)) as PartnerSessionState,messages: messages.map(message => JSON.parse(message) as unknown) };
    });
  }
  async saveSession(id: string,turnId: string,state: PartnerSessionState,at: string) {
    const saved = this.database.transaction(db => {
      requireConversation(db,id);
      // Only the currently executing owner may advance a private session.
      if (!db.prepare("SELECT 1 FROM conversation_turns WHERE conversation_id=? AND turn_id=? AND status='RUNNING'").get(id,turnId)) return;
      const messages = state.messages.map(message => JSON.stringify(message));
      const previous = this.#sessionMessages.get(id) ?? db.prepare("SELECT message_json FROM conversation_execution_messages WHERE conversation_id=? ORDER BY sequence").all(id).map(row => String(row.message_json));
      let common = 0;while (common < messages.length && messages[common] === previous[common]) common++;
      if (common < previous.length) db.prepare("DELETE FROM conversation_execution_messages WHERE conversation_id=? AND sequence>=?").run(id,common);
      const insert = db.prepare("INSERT INTO conversation_execution_messages(conversation_id,sequence,message_json) VALUES (?,?,?)");
      for (let index = common;index < messages.length;index++) insert.run(id,index,messages[index] ?? "null");
      const metadata = JSON.stringify({ ...state,messages: [] });
      db.prepare(`INSERT INTO conversation_execution_sessions(conversation_id,state_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at
        WHERE conversation_execution_sessions.state_json<>excluded.state_json`).run(id,metadata,at);
      return messages;
    });
    if (saved !== undefined) this.#rememberSession(id,saved);
  }
  #rememberSession(id: string,messages: string[]): void {
    this.#sessionMessages.delete(id);this.#sessionMessages.set(id,messages);
    while (this.#sessionMessages.size > 16) { const oldest = this.#sessionMessages.keys().next();if (oldest.done) break;this.#sessionMessages.delete(oldest.value); }
  }
  async submit(input: ConversationSubmission): Promise<ConversationDto> {
    return this.database.transaction(db => {
      const duplicate = db.prepare("SELECT conversation_id,body,config_json FROM conversation_turns WHERE request_id=?").get(input.requestId);
      if (duplicate !== undefined) {
        if (duplicate.conversation_id !== input.conversationId) throw new DomainError("conversation_request_conflict", "Request identity is already in use.");
        const config = JSON.parse(String(duplicate.config_json)) as ConversationTurnDto["config"];
        const current = requireConversation(db,input.conversationId);
        if (duplicate.body !== input.text || current.workbenchId !== input.workbenchId
          || (config.subagentsEnabled ?? true) !== (input.config.subagentsEnabled ?? true)
          || config.partnerId !== input.config.partnerId || config.networkId !== input.config.networkId || JSON.stringify(config.skills) !== JSON.stringify(input.config.skills)
          || JSON.stringify(config.attachmentIds) !== JSON.stringify(input.config.attachmentIds)) throw new DomainError("conversation_request_conflict", "Request identity is already in use.");
        return requireConversation(db, input.conversationId);
      }
      const current = read(db, input.conversationId);
      if (db.prepare("SELECT 1 FROM conversations WHERE conversation_id=? AND deleted_at IS NOT NULL").get(input.conversationId)) throw new DomainError("conversation_not_found", "Conversation was not found.");
      if (current?.archivedAt !== undefined) throw new DomainError("conversation_archived", "Restore the conversation before sending a message.");
      if (current !== null && current.workbenchId !== input.workbenchId) throw new DomainError("conversation_workbench_locked", "The conversation workbench cannot be changed.");
      if (!db.prepare("SELECT 1 FROM workbenches WHERE workbench_id=? AND status='ACTIVE'").get(input.workbenchId)) throw new DomainError("workbench_not_found", "Workbench was not found.");
      if (current?.turns.some(t => t.status === "QUEUED" || t.status === "RUNNING")) throw new DomainError("conversation_busy", "A conversation turn is already active.");
      db.prepare("INSERT INTO conversations(conversation_id,workbench_id,title,updated_at) VALUES (?,?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET updated_at=excluded.updated_at")
        .run(input.conversationId,input.workbenchId,sanitizeAgentConversationText(input.text).slice(0,80),input.at);
      db.prepare("INSERT INTO conversation_turns(turn_id,conversation_id,request_id,body,config_json,revision_json,status,created_at) VALUES (?,?,?,?,?,?,'QUEUED',?)")
        .run(input.turnId,input.conversationId,input.requestId,input.text,JSON.stringify(input.config),input.revision === undefined ? null : JSON.stringify(input.revision),input.at);
      // Internal Work identities retain workspace ownership and context attribution.
      db.prepare("INSERT INTO work_items(work_id,workbench_id,title,intent_json,access_mode,status,created_at,updated_at) VALUES (?,?,?,'{}','READ','READY',?,?)")
        .run(input.turnId,input.workbenchId,"Conversation turn",input.at,input.at);
      db.prepare("INSERT INTO work_access_policies VALUES (?,'READ')").run(input.turnId);
      db.prepare("INSERT INTO outbox(outbox_id,kind,payload_json,status,available_at,created_at) VALUES (?,'conversation.turn',?,'PENDING',?,?)")
        .run(`conversation:${input.turnId}`,JSON.stringify({ turnId: input.turnId }),input.at,input.at);
      return requireConversation(db,input.conversationId);
    });
  }
  async list(archived = false) { return this.database.transaction(db => ({ items: db.prepare(`SELECT c.*,NOT EXISTS (SELECT 1 FROM conversation_turns t WHERE t.conversation_id=c.conversation_id AND t.status IN ('QUEUED','RUNNING')) AS can_archive FROM conversations c WHERE deleted_at IS NULL AND archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY updated_at DESC,c.rowid DESC LIMIT 500`).all().map(summary) })); }
  async setState(id: string,state: Parameters<ConversationStore["setState"]>[1],at: string) {
    this.database.transaction(db => {
      const row = db.prepare("SELECT deleted_at FROM conversations WHERE conversation_id=?").get(id);
      if (row?.deleted_at !== null) {
        if (row !== undefined && state === "DELETED") return;
        throw new DomainError("conversation_not_found", "Conversation was not found.");
      }
      // State changes and submission serialize in this transaction, including turns outside the read window.
      if (db.prepare("SELECT 1 FROM conversation_turns WHERE conversation_id=? AND status IN ('QUEUED','RUNNING')").get(id)) throw new DomainError("conversation_busy", "Stop generation before archiving or deleting this conversation.");
      if (state === "DELETED") db.prepare("UPDATE conversations SET deleted_at=? WHERE conversation_id=?").run(at,id);
      else if (state === "ARCHIVED") db.prepare("UPDATE conversations SET archived_at=COALESCE(archived_at,?) WHERE conversation_id=?").run(at,id);
      else db.prepare("UPDATE conversations SET archived_at=NULL WHERE conversation_id=?").run(id);
    });
  }
  async get(id: string) { return this.database.transaction(db => read(db,id)); }
  async request(id: string) { return this.database.transaction(db => {
    const row = db.prepare("SELECT * FROM conversation_turns WHERE request_id=?").get(id);
    return row === undefined ? null : { conversation: requireConversation(db,String(row.conversation_id)),turn: turn(row),text: String(row.body) };
  }); }
  async turn(id: string) {
    return this.database.transaction(db => {
      const row = db.prepare("SELECT * FROM conversation_turns WHERE turn_id=?").get(id);
      if (row === undefined) return null;
      const conversation = read(db,String(row.conversation_id));
      if (conversation === null) return null;
      return { conversation, turn: turn(row), text: String(row.body),
        revision: typeof row.revision_json === "string" ? JSON.parse(row.revision_json) as PartnerRevision : null };
    });
  }
  async begin(id: string) { return this.database.transaction(db => {
    const changed = db.prepare("UPDATE conversation_turns SET status='RUNNING' WHERE turn_id=? AND status='QUEUED'").run(id).changes > 0;
    if (changed) db.prepare("UPDATE work_items SET status='RUNNING' WHERE work_id=?").run(id);
    return changed;
  }); }
  async update(id: string, patch: Parameters<ConversationStore["update"]>[1]) {
    this.database.transaction(db => {
      db.prepare("UPDATE conversation_turns SET entries_json=?,artifacts_json=?,status=?,error_code=? WHERE turn_id=? AND status='RUNNING'")
        .run(JSON.stringify(patch.entries),JSON.stringify(patch.artifacts),patch.status,patch.errorCode ?? null,id);
      if (patch.status !== "RUNNING") db.prepare("UPDATE work_items SET status=? WHERE work_id=?")
        .run(patch.status === "COMPLETED" ? "COMPLETED" : patch.status === "STOPPED" ? "CANCELED" : "FAILED",id);
    });
  }
  async stop(id: string) { this.database.transaction(db => {
    db.prepare("UPDATE work_items SET status='CANCELED' WHERE work_id IN (SELECT turn_id FROM conversation_turns WHERE conversation_id=? AND status='QUEUED')").run(id);
    db.prepare("UPDATE conversation_turns SET status='STOPPED' WHERE conversation_id=? AND status='QUEUED'").run(id);
  }); }
  async stopAll() { this.database.transaction(db => {
    db.prepare("UPDATE work_items SET status='CANCELED' WHERE work_id IN (SELECT turn_id FROM conversation_turns WHERE status='QUEUED')").run();
    db.prepare("UPDATE conversation_turns SET status='STOPPED' WHERE status='QUEUED'").run();
  }); }
  async recoverInterrupted(at: string) { this.database.transaction(db => {
    db.prepare(`UPDATE outbox SET available_at=MIN(available_at,?) WHERE kind='conversation.turn' AND status='PENDING'
      AND EXISTS (SELECT 1 FROM conversation_turns t WHERE outbox_id='conversation:'||t.turn_id AND t.status='QUEUED')`).run(at);
    db.prepare("UPDATE work_items SET status='FAILED',updated_at=? WHERE work_id IN (SELECT turn_id FROM conversation_turns WHERE status='RUNNING')").run(at);
    db.prepare("DELETE FROM workspace_leases WHERE work_id IN (SELECT turn_id FROM conversation_turns WHERE status='RUNNING')").run();
    db.prepare("DELETE FROM workspace_write_waiters WHERE work_id IN (SELECT turn_id FROM conversation_turns WHERE status='RUNNING')").run();
    db.prepare("UPDATE conversation_turns SET status='INTERRUPTED',error_code='conversation_interrupted' WHERE status='RUNNING'").run();
  }); }
}
