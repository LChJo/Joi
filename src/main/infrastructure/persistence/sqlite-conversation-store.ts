/* SQLite implements an asynchronous application port. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "../../domain/errors.js";
import type { ConversationStore, ConversationSubmission, ConversationSegment, ConversationForkIdentity, ConversationForkSource } from "../../application/ports/conversations.js";
import type { ConversationConfigDto, ConversationDto, ConversationSummaryDto, ConversationTurnDto } from "../../../shared/conversations.js";
import type { PartnerRevision } from "../../domain/partners/partner.js";
import type { PartnerSessionState } from "../../application/ports/partner-instances.js";
import { sanitizeAgentConversationText } from "../../application/partners/agent-conversation-presentation.js";
import { questionDto } from "../../application/joi/user-question-service.js";
import { listTurnUserQuestionsInTransaction, saveInterruptedQuestionChoiceInTransaction, settleRecoveredQuestionsInTransaction } from "./sqlite-user-question-store.js";

interface Database { transaction<T>(operation: (db: DatabaseSync) => T): T; }
type Row = Record<string, unknown>;
function segmentFromRow(row: Row): ConversationSegment {
  return { segmentId: String(row.segment_id),partnerId: String(row.partner_id),engine: row.engine as ConversationSegment["engine"],capabilityKey: String(row.capability_key),
    ...(typeof row.predecessor_id === "string" ? { predecessorId: row.predecessor_id } : {}),
    ...(typeof row.state_json === "string" ? { state: JSON.parse(row.state_json) as PartnerSessionState } : {}) };
}
function summary(row: Row): ConversationSummaryDto {
  return { conversationId: String(row.conversation_id), workbenchId: String(row.workbench_id), title: String(row.title), updatedAt: String(row.updated_at),
    ...(typeof row.archived_at === "string" ? { archivedAt: row.archived_at } : {}),...(row.can_archive === undefined ? {} : { canArchive: row.can_archive === 1 }) };
}
function turn(row: Row): ConversationTurnDto {
  const config = JSON.parse(String(row.config_json)) as ConversationTurnDto["config"];
  const entries = JSON.parse(String(row.entries_json)) as ConversationTurnDto["entries"];
  return { turnId: String(row.turn_id), text: sanitizeAgentConversationText(String(row.body)), createdAt: String(row.created_at),
    status: row.status as ConversationTurnDto["status"], config,
    entries: config.networkId === "native" ? entries : entries.map(entry => {
      if (entry.kind !== "ACTIVITY" || entry.activity.type !== "THINKING") return entry;
      const thinking = { ...entry.activity.thinking };
      delete thinking.summary;
      delete thinking.summaryTruncated;
      return { ...entry,activity: { ...entry.activity,thinking } };
    }),
    artifacts: JSON.parse(String(row.artifacts_json)) as ConversationTurnDto["artifacts"],
    ...(typeof row.error_code === "string" ? { errorCode: row.error_code } : {}),
    ...(typeof row.failure_json === "string" ? { failure: JSON.parse(row.failure_json) as NonNullable<ConversationTurnDto["failure"]> } : {}) };
}
function projectTurnQuestions(db: DatabaseSync, conversationId: string, turns: ConversationTurnDto[]): ConversationTurnDto[] {
  const grouped = new Map<string, NonNullable<ConversationTurnDto["questions"]>>();
  for (const question of listTurnUserQuestionsInTransaction(db,conversationId,turns.map(item => item.turnId))) {
    if (question.parentTurnId === undefined) continue;
    const questions = grouped.get(question.parentTurnId) ?? [];
    questions.push(questionDto(question));grouped.set(question.parentTurnId,questions);
  }
  return turns.map(item => {
    const questions = grouped.get(item.turnId);
    return questions === undefined ? item : { ...item,questions,waitingForUser: item.status === "RUNNING"
      && questions.some(question => question.delivery !== "INTERRUPTED" && (question.status === "ACTIVE" || question.status === "QUEUED")) };
  });
}
function read(db: DatabaseSync, id: string): ConversationDto | null {
  const row = db.prepare("SELECT * FROM conversations WHERE conversation_id=? AND deleted_at IS NULL").get(id);
  if (row === undefined) return null;
  const page = historyPage(db,id,undefined,50);
  const latest = db.prepare("SELECT MAX(sequence) AS sequence FROM conversation_changes WHERE conversation_id=?").get(id);
  const config = page.items.length === 0 ? db.prepare("SELECT config_json FROM conversation_forks WHERE conversation_id=?").get(id)?.config_json : undefined;
  return { ...summary(row),turns: page.items,...(page.nextCursor === null ? {} : { historyCursor: page.nextCursor }),
    eventCursor: eventCursor(id,Number(latest?.sequence ?? 0)),
    ...(typeof config === "string" ? { initialConfig: JSON.parse(config) as ConversationConfigDto } : {}),
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
  return { items: projectTurnQuestions(db,id,visible.map(turn)),nextCursor: rows.length > limit ? `history:${id}:${String(visible[0]?.position)}` : null };
}
function requireConversation(db: DatabaseSync,id: string): ConversationDto {
  const value = read(db,id);
  if (value === null) throw new DomainError("conversation_not_found", "Conversation was not found.");
  return value;
}

function existingFork(db: DatabaseSync,input: ConversationForkIdentity): ConversationDto | null {
  const target = db.prepare(`SELECT f.source_conversation_id,f.source_turn_id FROM conversations c
    LEFT JOIN conversation_forks f ON f.conversation_id=c.conversation_id WHERE c.conversation_id=?`).get(input.targetId);
  if (target === undefined) return null;
  if (target.source_conversation_id !== input.sourceId || target.source_turn_id !== input.turnId) {
    throw new DomainError("conversation_request_conflict","Conversation identity is already in use.");
  }
  return requireConversation(db,input.targetId);
}

function forkTurn(db: DatabaseSync,sourceId: string,turnId: string) {
  const source = db.prepare("SELECT workbench_id,title FROM conversations WHERE conversation_id=? AND deleted_at IS NULL").get(sourceId);
  if (source === undefined) throw new DomainError("conversation_not_found","Conversation was not found.");
  const selected = db.prepare("SELECT rowid AS position,* FROM conversation_turns WHERE conversation_id=? AND turn_id=?").get(sourceId,turnId);
  if (selected?.status !== "COMPLETED") throw new DomainError("conversation_fork_unavailable","Select a completed reply in this conversation.");
  return { source,selected };
}

function forkSeed(db: DatabaseSync,id: string): PartnerSessionState | undefined {
  const value = db.prepare("SELECT handoff_json FROM conversation_forks WHERE conversation_id=?").get(id)?.handoff_json;
  return typeof value === "string" ? JSON.parse(value) as PartnerSessionState : undefined;
}

export class SqliteConversationStore implements ConversationStore {
  readonly #sessionMessages = new Map<string,string[]>();
  readonly #sessionEntries = new Map<string,string[]>();
  constructor(private readonly database: Database) {}
  async existingFork(input: ConversationForkIdentity) { return this.database.transaction(db => existingFork(db,input)); }
  async forkSeed(id: string) { return this.database.transaction(db => forkSeed(db,id)); }
  async forkSource(sourceId: string,turnId: string): Promise<ConversationForkSource> {
    return this.database.transaction(db => {
      const { source,selected } = forkTurn(db,sourceId,turnId);
      const config = turn(selected).config;
      const binding = db.prepare(`SELECT s.*,b.message_count,NOT EXISTS (SELECT 1 FROM conversation_turn_segments next
        JOIN conversation_turns t ON t.turn_id=next.turn_id WHERE next.conversation_id=b.conversation_id
        AND next.segment_id=b.segment_id AND t.rowid>?) AS latest
        FROM conversation_turn_segments b JOIN conversation_execution_segments s
        ON s.conversation_id=b.conversation_id AND s.segment_id=b.segment_id WHERE b.turn_id=?`).get(Number(selected.position),turnId);
      const revision = typeof selected.revision_json === "string" ? JSON.parse(selected.revision_json) as PartnerRevision : undefined;
      const segment = binding === undefined ? { segmentId: "legacy",partnerId: config.partnerId,engine: revision?.engine ?? "pi-core" as const,capabilityKey: "legacy" } : segmentFromRow(binding);
      const messageCount = typeof binding?.message_count === "number" ? binding.message_count : binding?.latest === 1 ? segment.state?.messages.length : undefined;
      const inherited = forkSeed(db,sourceId);
      const history = db.prepare("SELECT * FROM conversation_turns WHERE conversation_id=? AND rowid<=? ORDER BY rowid")
        .all(sourceId,Number(selected.position)).map(row => ({ ...turn(row),text: String(row.body) }));
      return { workbenchId: String(source.workbench_id),title: String(source.title),segment,history,
        ...(messageCount === undefined ? {} : { messageCount }),...(inherited === undefined ? {} : { inherited }) };
    });
  }
  async createFork(input: Parameters<ConversationStore["createFork"]>[0]) {
    return this.database.transaction(db => {
      const previous = existingFork(db,input);
      if (previous !== null) return previous;
      const { source,selected } = forkTurn(db,input.sourceId,input.turnId);
      db.prepare("INSERT INTO conversations(conversation_id,workbench_id,title,updated_at) VALUES (?,?,?,?)")
        .run(input.targetId,String(source.workbench_id),input.title,input.at);
      db.prepare("INSERT INTO conversation_forks VALUES (?,?,?,?,?)")
        .run(input.targetId,input.sourceId,input.turnId,String(selected.config_json),JSON.stringify(input.state));
      return requireConversation(db,input.targetId);
    });
  }
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
    const segment = await this.segment(id);
    if (segment !== undefined) return segment.state;
    return this.#legacySession(id);
  }
  async #legacySession(id: string): Promise<PartnerSessionState | undefined> {
    return this.database.transaction(db => {
      requireConversation(db,id);
      const row = db.prepare("SELECT state_json FROM conversation_session_projections WHERE conversation_id=?").get(id);
      if (row === undefined) return undefined;
      const stored = db.prepare("SELECT sequence,message_json FROM conversation_execution_messages WHERE conversation_id=? ORDER BY sequence").all(id);
      const messages = stored.map((message,index) => {
        if (message.sequence !== index) throw new DomainError("conversation_session_invalid","Private session history is incomplete.");
        return String(message.message_json);
      });
      this.#rememberSession(id,messages);
      const state = JSON.parse(String(row.state_json)) as PartnerSessionState;
      if (state.piSession !== undefined) {
        const entries = db.prepare("SELECT sequence,entry_json FROM conversation_pi_entries WHERE conversation_id=? ORDER BY sequence").all(id).map((entry,index) => {
          if (entry.sequence !== index) throw new DomainError("conversation_session_invalid","Private session history is incomplete.");
          return String(entry.entry_json);
        });
        this.#remember(this.#sessionEntries,id,entries);
        state.piSession = { ...state.piSession,entries: entries.map(entry => JSON.parse(entry) as unknown) };
      }
      return { ...state,messages: messages.map(message => JSON.parse(message) as unknown) };
    });
  }
  async saveSession(id: string,turnId: string,state: PartnerSessionState,at: string) {
    const saved = this.database.transaction(db => {
      requireConversation(db,id);
      // Only the currently executing owner may advance a private session.
      if (!db.prepare("SELECT 1 FROM conversation_turns WHERE conversation_id=? AND turn_id=? AND status='RUNNING'").get(id,turnId)) return;
      const segment = db.prepare("SELECT segment_id FROM conversation_turn_segments WHERE conversation_id=? AND turn_id=?").get(id,turnId);
      if (segment !== undefined) {
        db.prepare("UPDATE conversation_execution_segments SET state_json=? WHERE conversation_id=? AND segment_id=?")
          .run(JSON.stringify(state),id,String(segment.segment_id));
        db.prepare("UPDATE conversation_turn_segments SET message_count=? WHERE turn_id=?").run(state.messages.length,turnId);
        return;
      }
      const entries = state.piSession?.entries.map(entry => JSON.stringify(entry));
      if (entries !== undefined) {
        const previousEntries = this.#sessionEntries.get(id) ?? db.prepare("SELECT entry_json FROM conversation_pi_entries WHERE conversation_id=? ORDER BY sequence").all(id).map(row => String(row.entry_json));
        if (previousEntries.length > entries.length || previousEntries.some((entry,index) => entry !== entries[index])) throw new DomainError("conversation_session_invalid","Private session entries are immutable.");
        const known = new Set(previousEntries.map(entry => (JSON.parse(entry) as { id: string }).id));
        const insertEntry = db.prepare("INSERT INTO conversation_pi_entries(conversation_id,sequence,entry_id,parent_id,entry_type,entry_json) VALUES (?,?,?,?,?,?)");
        for (let index = previousEntries.length;index < entries.length;index++) {
          const raw = entries[index] ?? "null",entry = JSON.parse(raw) as { id?: unknown;parentId?: unknown;type?: unknown } | null;
          if (entry === null || typeof entry.id !== "string" || known.has(entry.id) || typeof entry.type !== "string"
            || entry.parentId !== null && (typeof entry.parentId !== "string" || !known.has(entry.parentId))) throw new DomainError("conversation_session_invalid","Private session entries are invalid.");
          insertEntry.run(id,index,entry.id,entry.parentId,entry.type,raw);known.add(entry.id);
        }
      }
      const messages = state.messages.map(message => JSON.stringify(message));
      const previous = this.#sessionMessages.get(id) ?? db.prepare("SELECT message_json FROM conversation_execution_messages WHERE conversation_id=? ORDER BY sequence").all(id).map(row => String(row.message_json));
      let common = 0;while (common < messages.length && messages[common] === previous[common]) common++;
      if (common < previous.length) db.prepare("DELETE FROM conversation_execution_messages WHERE conversation_id=? AND sequence>=?").run(id,common);
      const insert = db.prepare("INSERT INTO conversation_execution_messages(conversation_id,sequence,message_json) VALUES (?,?,?)");
      for (let index = common;index < messages.length;index++) insert.run(id,index,messages[index] ?? "null");
      const metadata = JSON.stringify({ ...state,messages: [],...(state.piSession === undefined ? {} : { piSession: { ...state.piSession,entries: [] } }) });
      db.prepare(`INSERT INTO conversation_session_projections(conversation_id,state_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(conversation_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at
        WHERE conversation_session_projections.state_json<>excluded.state_json`).run(id,metadata,at);
      return { messages,entries };
    });
    if (saved !== undefined) {
      this.#rememberSession(id,saved.messages);
      if (saved.entries !== undefined) this.#remember(this.#sessionEntries,id,saved.entries);
    }
  }
  #rememberSession(id: string,messages: string[]): void {
    this.#remember(this.#sessionMessages,id,messages);
  }
  async segment(id: string,turnId?: string): Promise<ConversationSegment | undefined> {
    return this.database.transaction(db => {
      requireConversation(db,id);
      const row = turnId === undefined
        ? db.prepare("SELECT * FROM conversation_execution_segments WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1").get(id)
        : db.prepare(`SELECT s.* FROM conversation_execution_segments s JOIN conversation_turn_segments t
          ON t.conversation_id=s.conversation_id AND t.segment_id=s.segment_id WHERE t.conversation_id=? AND t.turn_id=?`).get(id,turnId);
      return row === undefined ? undefined : segmentFromRow(row);
    });
  }
  async segments(id: string): Promise<ConversationSegment[]> {
    const segments = this.database.transaction(db => {
      requireConversation(db,id);
      return db.prepare("SELECT * FROM conversation_execution_segments WHERE conversation_id=? ORDER BY sequence").all(id).map(segmentFromRow);
    });
    const legacy = await this.#legacySession(id);
    return legacy === undefined ? segments : [{ segmentId: "legacy",partnerId: "legacy",engine: legacy.engine,capabilityKey: "legacy",state: legacy },...segments];
  }
  async activateSegment(id: string,turnId: string,segment: ConversationSegment,expectedPredecessor?: string): Promise<ConversationSegment> {
    return this.database.transaction(db => {
      requireConversation(db,id);
      if (!db.prepare("SELECT 1 FROM conversation_turns WHERE conversation_id=? AND turn_id=? AND status='RUNNING'").get(id,turnId)) {
        throw new DomainError("conversation_execution_retired","The conversation execution is no longer active.");
      }
      const bound = db.prepare(`SELECT s.* FROM conversation_execution_segments s JOIN conversation_turn_segments t
        ON t.conversation_id=s.conversation_id AND t.segment_id=s.segment_id WHERE t.conversation_id=? AND t.turn_id=?`).get(id,turnId);
      if (bound !== undefined) return segmentFromRow(bound);
      const latest = db.prepare("SELECT * FROM conversation_execution_segments WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1").get(id);
      if ((latest?.segment_id ?? undefined) !== expectedPredecessor) throw new DomainError("conversation_handoff_conflict","The conversation execution changed during handoff.");
      if (latest?.segment_id !== segment.segmentId) {
        db.prepare(`INSERT INTO conversation_execution_segments(conversation_id,segment_id,sequence,partner_id,engine,capability_key,predecessor_id,state_json)
          VALUES (?,?,?,?,?,?,?,?)`).run(id,segment.segmentId,Number(latest?.sequence ?? 0) + 1,segment.partnerId,segment.engine,segment.capabilityKey,segment.predecessorId ?? null,
          segment.state === undefined ? null : JSON.stringify(segment.state));
      }
      db.prepare("INSERT INTO conversation_turn_segments(turn_id,conversation_id,segment_id) VALUES (?,?,?)").run(turnId,id,segment.segmentId);
      return latest?.segment_id === segment.segmentId ? segmentFromRow(latest) : segment;
    });
  }
  #remember(cache: Map<string,string[]>,id: string,items: string[]): void {
    cache.delete(id);cache.set(id,items);
    while (cache.size > 16) { const oldest = cache.keys().next();if (oldest.done) break;cache.delete(oldest.value); }
  }
  async submit(input: ConversationSubmission): Promise<ConversationDto> {
    return this.database.transaction(db => {
      const duplicate = db.prepare("SELECT conversation_id,body,config_json,question_recovery_context,question_recovery_source_turn_id FROM conversation_turns WHERE request_id=?").get(input.requestId);
      if (duplicate !== undefined) {
        if (duplicate.conversation_id !== input.conversationId) throw new DomainError("conversation_request_conflict", "Request identity is already in use.");
        const config = JSON.parse(String(duplicate.config_json)) as ConversationTurnDto["config"];
        const current = requireConversation(db,input.conversationId);
        if (duplicate.body !== input.text || current.workbenchId !== input.workbenchId
          || duplicate.question_recovery_source_turn_id !== (input.questionRecovery?.sourceTurnId ?? null)
          || (input.questionRecovery === undefined && duplicate.question_recovery_context !== (input.recoveryContext ?? null))
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
      if (input.questionRecovery !== undefined) {
        saveInterruptedQuestionChoiceInTransaction(db,{ ...input.questionRecovery,conversationId:input.conversationId,at:input.at });
      }
      db.prepare(`INSERT INTO conversation_turns(turn_id,conversation_id,request_id,body,config_json,revision_json,
        question_recovery_context,question_recovery_source_turn_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,'QUEUED',?)`)
        .run(input.turnId,input.conversationId,input.requestId,input.text,JSON.stringify(input.config),input.revision === undefined ? null : JSON.stringify(input.revision),
          input.recoveryContext ?? null,input.questionRecovery?.sourceTurnId ?? null,input.at);
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
  async rename(id: string,title: string,at: string) {
    return this.database.transaction(db => {
      const row = db.prepare("SELECT * FROM conversations WHERE conversation_id=? AND deleted_at IS NULL").get(id);
      if (row === undefined) throw new DomainError("conversation_not_found", "Conversation was not found.");
      if (row.title === title) return summary(row);
      db.prepare("UPDATE conversations SET title=?,updated_at=? WHERE conversation_id=?").run(title,at,id);
      return summary({ ...row,title,updated_at: at });
    });
  }
  async get(id: string) { return this.database.transaction(db => read(db,id)); }
  async request(id: string) { return this.database.transaction(db => {
    const row = db.prepare("SELECT * FROM conversation_turns WHERE request_id=?").get(id);
    return row === undefined ? null : { conversation: requireConversation(db,String(row.conversation_id)),turn: turn(row),text: String(row.body),
      ...(typeof row.question_recovery_source_turn_id === "string" ? { questionRecoverySourceTurnId: row.question_recovery_source_turn_id } : {}) };
  }); }
  async latestQuestionRecovery(sourceTurnId: string) {
    return this.database.transaction(db => {
      const row = db.prepare(`SELECT turn_id,status FROM conversation_turns WHERE question_recovery_source_turn_id=?
        ORDER BY rowid DESC LIMIT 1`).get(sourceTurnId);
      return row === undefined ? null : { turnId:String(row.turn_id),status:row.status as ConversationTurnDto["status"] };
    });
  }
  async turn(id: string) {
    return this.database.transaction(db => {
      const row = db.prepare("SELECT * FROM conversation_turns WHERE turn_id=?").get(id);
      if (row === undefined) return null;
      const conversation = read(db,String(row.conversation_id));
      if (conversation === null) return null;
      const projected = projectTurnQuestions(db,conversation.conversationId,[turn(row)])[0];
      if (projected === undefined) throw new Error("conversation_turn_missing");
      return { conversation, turn: projected, text: String(row.body),
        revision: typeof row.revision_json === "string" ? JSON.parse(row.revision_json) as PartnerRevision : null,
        ...(typeof row.question_recovery_context === "string" ? { recoveryContext: row.question_recovery_context } : {}),
        ...(typeof row.question_recovery_source_turn_id === "string" ? { questionRecoverySourceTurnId: row.question_recovery_source_turn_id } : {}) };
    });
  }
  async begin(id: string) { return this.database.transaction(db => {
    const changed = db.prepare("UPDATE conversation_turns SET status='RUNNING' WHERE turn_id=? AND status='QUEUED'").run(id).changes > 0;
    if (changed) db.prepare("UPDATE work_items SET status='RUNNING' WHERE work_id=?").run(id);
    return changed;
  }); }
  async runningPiTurns(): Promise<string[]> {
    return this.database.transaction(db => db.prepare(`SELECT t.turn_id FROM conversation_turns t
      JOIN conversation_turn_segments binding ON binding.turn_id=t.turn_id
      JOIN conversation_execution_segments s ON s.conversation_id=binding.conversation_id AND s.segment_id=binding.segment_id
      WHERE t.status='RUNNING' AND s.engine='pi-core'`).all().map(row => String(row.turn_id)));
  }
  async update(id: string, patch: Parameters<ConversationStore["update"]>[1]) {
    this.database.transaction(db => {
      const changed = db.prepare("UPDATE conversation_turns SET entries_json=?,artifacts_json=?,status=?,error_code=?,failure_json=? WHERE turn_id=? AND status='RUNNING'")
        .run(JSON.stringify(patch.entries),JSON.stringify(patch.artifacts),patch.status,patch.errorCode ?? null,patch.failure === undefined ? null : JSON.stringify(patch.failure),id);
      if (changed.changes === 0) return;
      if (patch.status !== "RUNNING") db.prepare("UPDATE work_items SET status=? WHERE work_id=?")
        .run(patch.status === "COMPLETED" ? "COMPLETED" : patch.status === "STOPPED" ? "CANCELED" : "FAILED",id);
      if (patch.status === "COMPLETED") settleRecoveredQuestionsInTransaction(db,id);
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
