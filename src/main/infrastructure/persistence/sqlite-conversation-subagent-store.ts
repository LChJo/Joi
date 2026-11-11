/* SQLite implements Promise-shaped application ports. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import type { ConversationChild,ConversationSubagentStore,ConversationChildInput } from "../../application/ports/conversation-subagents.js";
import { DomainError } from "../../domain/errors.js";

interface Database { transaction<T>(operation: (db: DatabaseSync) => T): T; }
function child(row: Record<string,unknown>): ConversationChild {
  return { ...JSON.parse(String(row.input_json)) as ConversationChildInput,childId: String(row.child_id),status: row.status as ConversationChild["status"],
    ...(typeof row.body === "string" ? { body: row.body } : {}) };
}
export class SqliteConversationSubagentStore implements ConversationSubagentStore {
  constructor(private readonly database: Database) {}
  async checkpoint(id: string,state: Parameters<ConversationSubagentStore["checkpoint"]>[1]) {
    this.database.transaction(db => db.prepare("UPDATE conversation_subagents SET session_json=? WHERE child_id=? AND status='RUNNING'").run(JSON.stringify(state),id));
  }
  async enqueue(input: ConversationChildInput & { childId: string;at: string }): Promise<ConversationChild> {
    return this.database.transaction(db => {
      const { childId,at,...value } = input;
      const prior = db.prepare("SELECT * FROM conversation_subagents WHERE parent_turn_id=? AND call_id=?").get(value.parentTurnId,value.callId);
      if (prior !== undefined) {
        const existing = child(prior);
        if (JSON.stringify(value) !== String(prior.input_json)) throw new DomainError("subagent_request_conflict","Child identity already has a different request.");
        return existing;
      }
      if (!db.prepare("SELECT 1 FROM conversation_turns WHERE turn_id=? AND status='RUNNING'").get(value.parentTurnId)
        || value.request.workId !== value.parentTurnId) throw new DomainError("subagent_parent_inactive","The parent conversation turn is inactive.");
      db.prepare("INSERT INTO conversation_subagents(child_id,parent_turn_id,call_id,input_json,status,created_at) VALUES (?,?,?,?,'QUEUED',?)")
        .run(childId,value.parentTurnId,value.callId,JSON.stringify(value),at);
      db.prepare("INSERT INTO outbox(outbox_id,kind,payload_json,status,available_at,created_at) VALUES (?,'conversation.subagent',?,'PENDING',?,?)")
        .run(`conversation_child:${childId}`,JSON.stringify({ childId }),at,at);
      return { ...value,childId,status: "QUEUED" };
    });
  }
  async get(id: string) { return this.database.transaction(db => { const row = db.prepare("SELECT * FROM conversation_subagents WHERE child_id=?").get(id);return row === undefined ? null : child(row); }); }
  async list(parentTurnId: string) { return this.database.transaction(db => db.prepare("SELECT * FROM conversation_subagents WHERE parent_turn_id=? ORDER BY rowid").all(parentTurnId).map(child)); }
  async claim(id: string) { return this.database.transaction(db => db.prepare(`UPDATE conversation_subagents SET status='RUNNING' WHERE child_id=? AND status='QUEUED'
    AND EXISTS (SELECT 1 FROM conversation_turns t WHERE t.turn_id=parent_turn_id AND t.status='RUNNING')`).run(id).changes > 0); }
  async finish(id: string,status: ConversationChild["status"],body?: string) { this.database.transaction(db => db.prepare("UPDATE conversation_subagents SET status=?,body=? WHERE child_id=? AND status='RUNNING'").run(status,body ?? null,id)); }
  async cancel(parentTurnId: string,id?: string) { this.database.transaction(db => db.prepare(`UPDATE conversation_subagents SET cancel_requested=1,
    status=CASE WHEN status='QUEUED' THEN 'CANCELED' ELSE status END WHERE parent_turn_id=? AND status IN ('QUEUED','RUNNING')${id === undefined ? "" : " AND child_id=?"}`).run(...(id === undefined ? [parentTurnId] : [parentTurnId,id]))); }
  async recover() { this.database.transaction(db => db.prepare("UPDATE conversation_subagents SET status='INTERRUPTED' WHERE status IN ('QUEUED','RUNNING')").run()); }
}
