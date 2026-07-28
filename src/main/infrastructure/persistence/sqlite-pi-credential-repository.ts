/* SQLite is synchronous by design; this adapter keeps the async port shape. */
/* eslint-disable @typescript-eslint/require-await */
import type { DatabaseSync } from "node:sqlite";

import type {
  EncryptedPiCredentialRecord,
  PiCredentialRecordStore,
} from "../../application/ports/model-source-ports.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

type Row = Record<string, unknown>;

export class SqlitePiCredentialRepository implements PiCredentialRecordStore {
  constructor(private readonly database: TransactionalDatabase) {}

  async read(providerId: string): Promise<EncryptedPiCredentialRecord | null> {
    const row = this.database.transaction((connection) => connection.prepare(`
      SELECT provider_id, credential_type, encrypted_blob, credential_version
        FROM model_source_credentials WHERE provider_id = ?`).get(providerId)) as Row | undefined;
    if (row === undefined) return null;
    if (!(row.encrypted_blob instanceof Uint8Array) || typeof row.provider_id !== "string"
      || typeof row.credential_type !== "string" || typeof row.credential_version !== "number") {
      throw new Error("pi_credential_record_invalid");
    }
    return {
      encryptedBlob: new Uint8Array(row.encrypted_blob),
      providerId: row.provider_id,
      type: row.credential_type as EncryptedPiCredentialRecord["type"],
      version: row.credential_version,
    };
  }

  async list() {
    return this.database.transaction((connection) => connection.prepare(`
      SELECT provider_id, credential_type, credential_version
        FROM model_source_credentials ORDER BY provider_id`).all()).map((value) => {
      const row = value as Row;
      if (typeof row.provider_id !== "string" || typeof row.credential_type !== "string" || typeof row.credential_version !== "number") {
        throw new Error("pi_credential_record_invalid");
      }
      return {
        providerId: row.provider_id,
        type: row.credential_type as EncryptedPiCredentialRecord["type"],
        version: row.credential_version,
      };
    });
  }

  async write(record: EncryptedPiCredentialRecord): Promise<void> {
    this.database.transaction((connection) => connection.prepare(`
      INSERT INTO model_source_credentials
        (provider_id, credential_type, encrypted_blob, credential_version, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        credential_type = excluded.credential_type,
        encrypted_blob = excluded.encrypted_blob,
        credential_version = excluded.credential_version,
        updated_at = excluded.updated_at`).run(
      record.providerId,
      record.type,
      record.encryptedBlob,
      record.version,
      new Date().toISOString(),
    ));
  }

  async delete(providerId: string): Promise<void> {
    this.database.transaction((connection) => connection.prepare(
      "DELETE FROM model_source_credentials WHERE provider_id = ?",
    ).run(providerId));
  }
}
