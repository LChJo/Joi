/* SQLite implements an asynchronous application port. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import type { GitCommandStore } from "../../application/ports/conversation-workspace.js";
import type { GitCommandDto, GitCommandInput } from "../../../shared/conversations.js";
import { DomainError } from "../../domain/errors.js";
interface Database { transaction<T>(operation: (db: DatabaseSync) => T): T; }
function projection(row: Record<string, unknown>): GitCommandDto {
  return { commandId: String(row.command_id),status: row.status as GitCommandDto["status"],...(typeof row.error_code === "string" ? { errorCode: row.error_code } : {}) };
}
export class SqliteGitCommandStore implements GitCommandStore {
  constructor(private readonly database: Database) {}
  async submit(workbenchId: string,input: GitCommandInput,commandId: string,at: string) {
    return this.database.transaction(db => {
      const prior = db.prepare("SELECT * FROM workspace_git_commands WHERE request_id=?").get(input.requestId);
      if (prior !== undefined) {
        if (prior.workbench_id !== workbenchId || prior.input_json !== JSON.stringify(input)) throw new DomainError("git_request_conflict", "Git request identity is already in use.");
        return projection(prior);
      }
      db.prepare("INSERT INTO workspace_git_commands(command_id,workbench_id,request_id,input_json,status,created_at) VALUES (?,?,?,?,'QUEUED',?)")
        .run(commandId,workbenchId,input.requestId,JSON.stringify(input),at);
      db.prepare("INSERT INTO work_items(work_id,workbench_id,title,intent_json,access_mode,status,created_at,updated_at) VALUES (?,?,?,'{}','WRITE','READY',?,?)")
        .run(commandId,workbenchId,"User Git operation",at,at);
      db.prepare("INSERT INTO work_access_policies VALUES (?,'WRITE')").run(commandId);
      db.prepare("INSERT INTO outbox(outbox_id,kind,payload_json,status,available_at,created_at) VALUES (?,'conversation.git',?,'PENDING',?,?)")
        .run(`git:${commandId}`,JSON.stringify({ commandId }),at,at);
      return { commandId,status: "QUEUED" as const };
    });
  }
  async get(id: string) { return this.database.transaction(db => {
    const row = db.prepare("SELECT * FROM workspace_git_commands WHERE command_id=?").get(id);
    return row === undefined ? null : { ...projection(row),workbenchId: String(row.workbench_id),input: JSON.parse(String(row.input_json)) as GitCommandInput };
  }); }
  async begin(id: string) { return this.database.transaction(db => {
    const changed = db.prepare("UPDATE workspace_git_commands SET status='RUNNING' WHERE command_id=? AND status='QUEUED'").run(id).changes > 0;
    if (changed) db.prepare("UPDATE work_items SET status='RUNNING' WHERE work_id=?").run(id);
    return changed;
  }); }
  async finish(id: string,errorCode?: string) { this.database.transaction(db => {
    db.prepare("UPDATE workspace_git_commands SET status=?,error_code=? WHERE command_id=? AND status='RUNNING'").run(errorCode === undefined ? "COMPLETED" : "FAILED",errorCode ?? null,id);
    db.prepare("UPDATE work_items SET status=? WHERE work_id=?").run(errorCode === undefined ? "COMPLETED" : "FAILED",id);
  }); }
  async recoverInterrupted() { this.database.transaction(db => {
    db.prepare("UPDATE work_items SET status='FAILED' WHERE work_id IN (SELECT command_id FROM workspace_git_commands WHERE status='RUNNING')").run();
    db.prepare("DELETE FROM workspace_leases WHERE work_id IN (SELECT command_id FROM workspace_git_commands WHERE status='RUNNING')").run();
    db.prepare("UPDATE workspace_git_commands SET status='INTERRUPTED',error_code='git_interrupted' WHERE status='RUNNING'").run();
  }); }
  async stopQueued() { this.database.transaction(db => {
    db.prepare("UPDATE work_items SET status='CANCELED' WHERE work_id IN (SELECT command_id FROM workspace_git_commands WHERE status='QUEUED')").run();
    db.prepare("UPDATE workspace_git_commands SET status='FAILED',error_code='git_stopped' WHERE status='QUEUED'").run();
  }); }
}
