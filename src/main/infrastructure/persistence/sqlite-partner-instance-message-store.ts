/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { PartnerInstanceMessageStore } from "../../application/ports/partner-instances.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

export class SqlitePartnerInstanceMessageStore implements PartnerInstanceMessageStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async clear(instanceId: string): Promise<void> {
    this.database.transaction((connection) => connection.prepare(
      "DELETE FROM partner_instance_messages WHERE instance_id = ?",
    ).run(instanceId));
  }

  async load(instanceId: string, strict = false): Promise<unknown[] | null> {
    const rows = this.database.transaction((connection) => connection.prepare(
      "SELECT message_json FROM partner_instance_messages WHERE instance_id = ? ORDER BY sequence",
    ).all(instanceId)) as { message_json?: unknown }[];
    if (rows.length === 0) return null;
    const messages: unknown[] = [];
    for (const row of rows) {
      if (typeof row.message_json !== "string") throw new Error("partner_instance_message_invalid");
      try {
        messages.push(JSON.parse(row.message_json));
      } catch {
        if (strict) throw new Error("workspace_checkpoint_invalid");
        // A corrupt row must not poison the whole conversation; skip it and keep the tail.
      }
    }
    return messages;
  }

  async save(instanceId: string, messages: unknown[]): Promise<void> {
    this.database.transaction((connection) => {
      connection.prepare("DELETE FROM partner_instance_messages WHERE instance_id = ?").run(instanceId);
      const insert = connection.prepare(`INSERT INTO partner_instance_messages
        (message_id, instance_id, sequence, message_json, created_at) VALUES (?, ?, ?, ?, ?)`);
      const createdAt = new Date().toISOString();
      messages.forEach((message, sequence) => insert.run(randomUUID(), instanceId, sequence, JSON.stringify(message), createdAt));
    });
  }
}
