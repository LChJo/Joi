/* SQLite ports are synchronous internally. */
/* eslint-disable @typescript-eslint/require-await */
import { randomUUID } from "node:crypto";
import { DomainError } from "../../domain/errors.js";
import type { RuntimeDatabase } from "./runtime-database.js";
import { exportBasename, type CreateResultExport, type ResultExportDto } from "../../../shared/result-export.js";

export interface ExportRecord extends ResultExportDto {
  body: string; basename: string; format: "pdf" | "png"; digest: string; goalId: string;
}
export class SqliteResultExports {
  constructor(private readonly db: Pick<RuntimeDatabase, "transaction">) {}
  async find(input: CreateResultExport): Promise<ResultExportDto | null> {
    const row = this.db.transaction(c => c.prepare('SELECT export_id, digest, format, goal_id FROM result_exports WHERE idempotency_key = ?').get(input.idempotencyKey));
    if (!row) return null;
    if (row.digest !== input.digest || row.format !== input.format || row.goal_id !== input.goalId) throw new DomainError('export_idempotency_conflict', 'export_idempotency_conflict');
    return this.get(String(row.export_id));
  }
  async create(input: CreateResultExport & { title: string; body: string }): Promise<ResultExportDto> {
    const exportId = this.db.transaction(c => {
      const old = c.prepare('SELECT export_id, digest, format, goal_id FROM result_exports WHERE idempotency_key = ?').get(input.idempotencyKey);
      if (old) {
        if (old.digest !== input.digest || old.format !== input.format || old.goal_id !== input.goalId) throw new DomainError('export_idempotency_conflict', 'export_idempotency_conflict');
        return String(old.export_id);
      }
      const id = randomUUID(); const time = new Date().toISOString();
      c.prepare(`INSERT INTO result_exports (export_id,idempotency_key,goal_id,format,digest,body,basename,status,created_at) VALUES (?,?,?,?,?,?,?,'queued',?)`).run(id, input.idempotencyKey, input.goalId, input.format, input.digest, input.body, exportBasename(input.title,time,id),time);
      c.prepare(`INSERT INTO outbox (outbox_id,kind,payload_json,status,attempt_count,available_at,created_at) VALUES (?,'result.export',?,'PENDING',0,?,?)`).run(`export_${id}`, JSON.stringify({ exportId: id }),time,time);
      return id;
    });
    const job = this.record(exportId);
    if (!job) throw new Error('export_not_found');
    return this.public(job);
  }
  record(id: string): ExportRecord | null {
    const r = this.db.transaction(c => c.prepare('SELECT * FROM result_exports WHERE export_id = ?').get(id));
    if (!r) return null;
    const filenames = JSON.parse(String(r.filenames_json)) as string[];
    return { exportId: id, status: r.status as ExportRecord['status'], filenames, count: filenames.length,
      body: String(r.body), basename: String(r.basename), format: r.format as 'pdf' | 'png', digest: String(r.digest), goalId: String(r.goal_id),
      ...(typeof r.error_code === 'string' ? { errorCode: r.error_code } : {}) };
  }
  public(r: ExportRecord): ResultExportDto {
    return { exportId: r.exportId, status: r.status, filenames: r.filenames, count: r.count, ...(r.errorCode ? { errorCode: r.errorCode } : {}) };
  }
  async get(id: string): Promise<ResultExportDto | null> { const r = this.record(id); return r ? this.public(r) : null; }
  update(id: string, status: ExportRecord['status'], filenames: string[] = [], error?: string) {
    this.db.transaction(c => c.prepare('UPDATE result_exports SET status = ?, filenames_json = ?, error_code = ? WHERE export_id = ?').run(status, JSON.stringify(filenames), error ?? null, id));
  }
}
