/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import type { PartnerPromptStore } from "../../application/ports/partner-execution.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

export class SqlitePartnerPromptStore implements PartnerPromptStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async read(promptRef: string): Promise<string | null> {
    const row = this.database.transaction((connection) => connection.prepare(
      "SELECT body FROM partner_prompts WHERE prompt_ref = ?",
    ).get(promptRef)) as { body?: unknown } | undefined;
    if (row === undefined) return null;
    if (typeof row.body !== "string") throw new Error("partner_prompt_record_invalid");
    return row.body;
  }

  async save(input: { body: string; createdAt: string; promptRef: string }): Promise<void> {
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    this.database.transaction((connection) => connection.prepare(`INSERT INTO partner_prompts
      (prompt_ref, body, sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    ).run(input.promptRef, input.body, sha256, input.createdAt, input.createdAt));
  }
}
