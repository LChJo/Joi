/* SQLite 实现 Promise 形状的应用端口。 */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeDatabase } from "./runtime-database.js";
import type { UserQuestionRecord, UserQuestionStore } from "../../application/ports/user-questions.js";
import { USER_QUESTION_TIMEOUT_MILLIS, type UserQuestionAnswer, type UserQuestionScope } from "../../../shared/user-questions.js";
import { DomainError } from "../../domain/errors.js";

function decode(row: Record<string, unknown> | undefined): UserQuestionRecord | null {
  if (row === undefined) return null;
  const record = JSON.parse(String(row.payload_json)) as UserQuestionRecord;
  delete record.expiresAt;delete record.parentTurnId;
  return { ...record,questionId: String(row.question_id),scope: { kind: row.scope_kind as UserQuestionScope["kind"],id: String(row.scope_id) },
    ownerId: String(row.owner_id),version: Number(row.version),status: row.status as UserQuestionRecord["status"],delivery: row.delivery as UserQuestionRecord["delivery"],
    ...(typeof row.parent_turn_id === "string" ? { parentTurnId: row.parent_turn_id } : {}),
    ...(typeof row.expires_at === "string" ? { expiresAt: row.expires_at } : {}) };
}

function bindConversationParent(db: DatabaseSync, question: UserQuestionRecord): UserQuestionRecord {
  const record = { ...question };delete record.parentTurnId;
  if (question.scope.kind !== "CONVERSATION") return record;
  const child = db.prepare("SELECT parent_turn_id FROM conversation_subagents WHERE child_id=?").get(question.ownerId);
  const parentTurnId = typeof child?.parent_turn_id === "string" ? child.parent_turn_id : question.ownerId;
  const parent = db.prepare("SELECT conversation_id FROM conversation_turns WHERE turn_id=?").get(parentTurnId);
  if (parent !== undefined && parent.conversation_id !== question.scope.id) throw new DomainError("question_invalid", "The question owner belongs to another conversation.");
  return { ...record,parentTurnId };
}
function required(row: Record<string,unknown> | undefined): UserQuestionRecord {
  const record = decode(row);if (record === null) throw new Error("question_record_missing");return record;
}
function save(db: DatabaseSync, record: UserQuestionRecord): void {
  db.prepare("UPDATE user_questions SET status=?,expires_at=?,delivery=?,payload_json=? WHERE question_id=?")
    .run(record.status,record.expiresAt ?? null,record.delivery,JSON.stringify(record),record.questionId);
}
export function activateUserQuestionInTransaction(db: DatabaseSync, scope: UserQuestionScope, now: string): void {
  if (db.prepare("SELECT 1 FROM user_questions WHERE scope_kind=? AND scope_id=? AND status='ACTIVE' AND delivery='PENDING'").get(scope.kind,scope.id) !== undefined) return;
  const next = decode(db.prepare("SELECT * FROM user_questions WHERE scope_kind=? AND scope_id=? AND status='QUEUED' AND delivery='PENDING' ORDER BY sequence LIMIT 1").get(scope.kind,scope.id));
  if (next !== null) save(db,{ ...next,status: "ACTIVE",activatedAt: now,expiresAt: new Date(Date.parse(now)+USER_QUESTION_TIMEOUT_MILLIS).toISOString() });
}

export function enqueueUserQuestionInTransaction(db: DatabaseSync, question: UserQuestionRecord, now: string, shouldActivate = true): UserQuestionRecord {
  const existing = decode(db.prepare("SELECT * FROM user_questions WHERE question_id=?").get(question.questionId));
  if (existing !== null) return existing;
  const bound = bindConversationParent(db,question);
  db.prepare("INSERT INTO user_questions(question_id,scope_kind,scope_id,owner_id,parent_turn_id,version,status,delivery,payload_json) VALUES(?,?,?,?,?,?,'QUEUED',?,?)")
    .run(bound.questionId,bound.scope.kind,bound.scope.id,bound.ownerId,bound.parentTurnId ?? null,bound.version,bound.delivery,JSON.stringify({ ...bound,status: "QUEUED" }));
  if (shouldActivate) activateUserQuestionInTransaction(db,question.scope,now);
  return required(db.prepare("SELECT * FROM user_questions WHERE question_id=?").get(question.questionId));
}
export function listUserQuestionsInTransaction(db: DatabaseSync, scope: UserQuestionScope): UserQuestionRecord[] {
  return db.prepare("SELECT * FROM user_questions WHERE scope_kind=? AND scope_id=? ORDER BY sequence").all(scope.kind,scope.id).map(row => required(row));
}
export function listTurnUserQuestionsInTransaction(db: DatabaseSync, conversationId: string, turnIds: readonly string[]): UserQuestionRecord[] {
  if (turnIds.length === 0) return [];
  return db.prepare(`SELECT * FROM user_questions WHERE scope_kind='CONVERSATION' AND scope_id=?
    AND parent_turn_id IN (${turnIds.map(() => "?").join(",")}) ORDER BY sequence`).all(conversationId,...turnIds).map(row => required(row));
}
export function answerUserQuestionInTransaction(db: DatabaseSync, questionId: string, version: number, answer: UserQuestionAnswer, now: string): UserQuestionRecord | null {
  const deadline = answer.source === "TIMEOUT_DEFAULT" ? "expires_at<=?" : "expires_at>?";
  const current = decode(db.prepare(`SELECT * FROM user_questions
    WHERE question_id=? AND version=? AND status='ACTIVE' AND delivery='PENDING' AND ${deadline}`).get(questionId,version,now));
  if (current === null) return null;
  const next: UserQuestionRecord = { ...current,status: "ANSWERED",answer };
  save(db,next); activateUserQuestionInTransaction(db,current.scope,now); return next;
}

export function saveInterruptedQuestionChoiceInTransaction(db: DatabaseSync, input: {
  conversationId: string; sourceTurnId: string; questionId: string; at: string;
}): void {
  const question = decode(db.prepare(`SELECT * FROM user_questions WHERE scope_kind='CONVERSATION'
    AND scope_id=? AND parent_turn_id=? AND question_id=? AND delivery='INTERRUPTED'
    AND status IN ('ACTIVE','QUEUED','ANSWERED')`).get(input.conversationId,input.sourceTurnId,input.questionId));
  if (question === null) throw new DomainError("question_stale", "The question is not interrupted.");
  if (question.answer === undefined) save(db, { ...question,status:"ANSWERED",answer:{
    text:question.defaultAnswer,selectedOptionIds:question.defaultOptionIds,source:"USER_DEFAULT",answeredAt:input.at,
  } });
}

export function settleRecoveredQuestionsInTransaction(db: DatabaseSync, recoveryTurnId: string): void {
  const recovery = db.prepare("SELECT conversation_id,question_recovery_source_turn_id FROM conversation_turns WHERE turn_id=?").get(recoveryTurnId);
  if (typeof recovery?.conversation_id !== "string" || typeof recovery.question_recovery_source_turn_id !== "string") return;
  for (const question of listTurnUserQuestionsInTransaction(db,recovery.conversation_id,[recovery.question_recovery_source_turn_id])) {
    if (question.delivery !== "INTERRUPTED") continue;
    if (question.status === "ANSWERED" && question.answer !== undefined) save(db,{ ...question,delivery:"DELIVERED" });
    else if (question.status === "ACTIVE" || question.status === "QUEUED") save(db,{ ...question,status:"CANCELED" });
  }
}

export class SqliteUserQuestionStore implements UserQuestionStore {
  constructor(private readonly database: RuntimeDatabase) {}
  async enqueue(question: UserQuestionRecord, now: string): Promise<UserQuestionRecord> {
    return this.database.transaction(db => enqueueUserQuestionInTransaction(db,question,now));
  }
  async list(scope: UserQuestionScope): Promise<UserQuestionRecord[]> {
    return this.database.transaction(db => listUserQuestionsInTransaction(db,scope));
  }
  async get(questionId: string): Promise<UserQuestionRecord | null> {
    return this.database.transaction(db => decode(db.prepare("SELECT * FROM user_questions WHERE question_id=?").get(questionId)));
  }
  async answer(questionId: string, version: number, answer: UserQuestionAnswer, now: string): Promise<UserQuestionRecord | null> {
    return this.database.transaction(db => answerUserQuestionInTransaction(db,questionId,version,answer,now));
  }
  async due(now: string): Promise<UserQuestionRecord[]> {
    return this.database.transaction(db => db.prepare("SELECT * FROM user_questions WHERE status='ACTIVE' AND delivery='PENDING' AND expires_at<=? ORDER BY sequence LIMIT 100").all(now).map(row => required(row)));
  }
  async pendingGoalAnswers(): Promise<UserQuestionRecord[]> {
    return this.database.transaction(db => db.prepare("SELECT * FROM user_questions WHERE scope_kind='GOAL' AND status='ANSWERED' AND delivery='PENDING' ORDER BY sequence LIMIT 100").all().map(row => required(row)));
  }
  async cancelOwner(ownerId: string, now: string): Promise<string[]> {
    return this.database.transaction(db => {
      const records = db.prepare("SELECT * FROM user_questions WHERE owner_id=? AND status IN ('ACTIVE','QUEUED')").all(ownerId).map(row => required(row));
      for (const record of records) save(db,{ ...record,status: "CANCELED" });
      for (const record of records) activateUserQuestionInTransaction(db,record.scope,now);
      return records.map(record => record.questionId);
    });
  }
  async cancelQuestion(scope: UserQuestionScope, questionId: string, now: string): Promise<boolean> {
    return this.database.transaction(db => {
      const record = decode(db.prepare("SELECT * FROM user_questions WHERE question_id=? AND scope_kind=? AND scope_id=? AND status IN ('ACTIVE','QUEUED')").get(questionId,scope.kind,scope.id));
      if (record === null) return false;
      save(db,{ ...record,status: "CANCELED" });activateUserQuestionInTransaction(db,scope,now);return true;
    });
  }
  async markDelivered(questionId: string): Promise<void> {
    this.database.transaction(db => db.prepare("UPDATE user_questions SET delivery='DELIVERED' WHERE question_id=? AND (status='ANSWERED' OR (status='CANCELED' AND delivery='INTERRUPTED'))").run(questionId));
  }
  async interruptOwner(ownerId: string, now: string): Promise<UserQuestionRecord[]> {
    return this.database.transaction(db => {
      const records = db.prepare(`UPDATE user_questions SET delivery='INTERRUPTED'
        WHERE owner_id=? AND delivery='PENDING' AND status IN ('ACTIVE','QUEUED','ANSWERED') RETURNING *`).all(ownerId).map(row => required(row));
      for (const record of records) activateUserQuestionInTransaction(db,record.scope,now);
      return records;
    });
  }
  async interruptUnfinishedConversations(): Promise<void> {
    this.database.transaction(db => db.prepare(`UPDATE user_questions SET delivery='INTERRUPTED'
      WHERE scope_kind='CONVERSATION' AND delivery='PENDING' AND status IN ('ACTIVE','QUEUED','ANSWERED')
      AND (EXISTS (SELECT 1 FROM conversation_turns t WHERE t.turn_id=user_questions.parent_turn_id
        AND t.conversation_id=user_questions.scope_id AND t.status IN ('RUNNING','INTERRUPTED'))
      OR EXISTS (SELECT 1 FROM conversation_subagents child JOIN conversation_turns t ON t.turn_id=child.parent_turn_id
        WHERE child.child_id=user_questions.owner_id AND t.conversation_id=user_questions.scope_id
        AND child.status IN ('QUEUED','RUNNING','INTERRUPTED')))`
    ).run());
  }
}
