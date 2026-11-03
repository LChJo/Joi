/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { PartnerKnowledgeDocMeta, PartnerKnowledgeStore } from "../../application/ports/partner-knowledge.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function mapMeta(row: Row): PartnerKnowledgeDocMeta {
  const bytes = row.bytes;
  if (typeof row.doc_id !== "string" || typeof row.filename !== "string" || typeof row.sha256 !== "string"
    || typeof row.created_at !== "string" || typeof bytes !== "number") throw new Error("partner_knowledge_record_invalid");
  return { bytes, createdAt: row.created_at, docId: row.doc_id, filename: row.filename, sha256: row.sha256 };
}

export class SqlitePartnerKnowledgeStore implements PartnerKnowledgeStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async count(partnerId: string): Promise<number> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT COUNT(*) AS count FROM partner_knowledge_docs WHERE partner_id = ?",
    ).get(partnerId)) as { count: number };
    return row.count;
  }

  async copyTo(srcPartnerId: string, dstPartnerId: string, nextDocId: () => string, createdAt: string): Promise<number> {
    return this.database.transaction((connection) => {
      const rows = connection.prepare(`SELECT filename, body, sha256, bytes
        FROM partner_knowledge_docs WHERE partner_id = ? ORDER BY created_at, doc_id`).all(srcPartnerId) as Row[];
      const insert = connection.prepare(`INSERT INTO partner_knowledge_docs
        (doc_id, partner_id, filename, body, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const row of rows) {
        if (typeof row.filename !== "string" || typeof row.body !== "string"
          || typeof row.sha256 !== "string" || typeof row.bytes !== "number") throw new Error("partner_knowledge_record_invalid");
        insert.run(nextDocId(), dstPartnerId, row.filename, row.body, row.sha256, row.bytes, createdAt);
      }
      return rows.length;
    });
  }

  async listMeta(partnerId: string): Promise<PartnerKnowledgeDocMeta[]> {
    return this.database.transaction((connection) => connection.prepare(
      "SELECT doc_id, filename, sha256, bytes, created_at FROM partner_knowledge_docs WHERE partner_id = ? ORDER BY created_at, doc_id",
    ).all(partnerId)).map((row) => mapMeta(row as Row));
  }

  async readBodies(partnerId: string): Promise<{ body: string; filename: string }[]> {
    return this.database.transaction((connection) => connection.prepare(
      "SELECT filename, body FROM partner_knowledge_docs WHERE partner_id = ? ORDER BY created_at, doc_id",
    ).all(partnerId)).map((row) => {
      const typed = row as Row;
      if (typeof typed.filename !== "string" || typeof typed.body !== "string") throw new Error("partner_knowledge_record_invalid");
      return { body: typed.body, filename: typed.filename };
    });
  }

  async remove(partnerId: string, docId: string): Promise<boolean> {
    return this.database.transaction((connection) => connection.prepare(
      "DELETE FROM partner_knowledge_docs WHERE doc_id = ? AND partner_id = ?",
    ).run(docId, partnerId).changes > 0);
  }

  async save(input: { body: string; bytes: number; createdAt: string; docId: string; filename: string; partnerId: string }): Promise<string> {
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    this.database.transaction((connection) => connection.prepare(`INSERT INTO partner_knowledge_docs
      (doc_id, partner_id, filename, body, sha256, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      input.docId, input.partnerId, input.filename, input.body, sha256, input.bytes, input.createdAt,
    ));
    return sha256;
  }
}
