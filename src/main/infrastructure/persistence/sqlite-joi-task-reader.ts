/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type { JoiTaskInbox, JoiTaskPendingInput, JoiTaskStaleTurn } from "../../application/ports/joi-task.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

function textValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error("joi_task_row_invalid");
  return value;
}

export class SqliteJoiTaskReader implements JoiTaskInbox {
  constructor(private readonly dependencies: {
    database: TransactionalDatabase;
    failTurn: (inputId: string, turnId: string) => Promise<void>;
    park: (inputId: string, failure: { failureCount: number; reasonCode: string }) => Promise<void>;
  }) {}

  async listPendingInputs(): Promise<JoiTaskPendingInput[]> {
    return (this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT input_id, created_at FROM joi_inbox_messages
       WHERE status = 'PENDING' AND dismissed_at IS NULL
       ORDER BY created_at, input_id LIMIT 50`).all()) as Row[])
      .map((row) => ({ createdAt: textValue(row, "created_at"), inputId: textValue(row, "input_id") }));
  }

  async park(inputId: string, failure: { failureCount: number; reasonCode: string }): Promise<void> {
    await this.dependencies.park(inputId, failure);
  }

  async listStaleRunningTurns(olderThan: string): Promise<JoiTaskStaleTurn[]> {
    return (this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT input_id, turn_id FROM joi_turns
       WHERE status = 'RUNNING' AND updated_at <= ?
       ORDER BY updated_at, turn_id LIMIT 50`).all(olderThan)) as Row[])
      .map((row) => ({ inputId: textValue(row, "input_id"), turnId: textValue(row, "turn_id") }));
  }

  async failTurn(inputId: string, turnId: string): Promise<void> {
    await this.dependencies.failTurn(inputId, turnId);
  }
}
