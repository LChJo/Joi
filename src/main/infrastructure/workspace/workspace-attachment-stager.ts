import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DatabaseSync } from "node:sqlite";

import type { JoiAttachmentPort } from "../../application/ports/managed-file-ports.js";
import type { StagedAttachment, WorkAttachmentStagerPort } from "../../application/ports/partner-dispatch-delivery.js";
import { DomainError } from "../../domain/errors.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Copies the attachments bound to a dispatch's source input into its independent
 * input directory at joi-attachments/<attachmentId>/<filename> so local partners
 * can read the originals. Legacy staging uses the workspace root. Unchanged targets
 * are skipped, changed targets are replaced atomically.
 */
export class WorkAttachmentStager implements WorkAttachmentStagerPort {
  constructor(private readonly dependencies: {
    attachments: Pick<JoiAttachmentPort, "read">;
    database: TransactionalDatabase;
    taskDirectory?: string;
  }) {}

  async stage(input: { inputId: string; workspacePath: string; workId?: string }): Promise<StagedAttachment[]> {
    const rows = this.dependencies.database.transaction((connection) => connection.prepare(`
      SELECT a.attachment_id, a.filename
        FROM joi_inbox_attachments ia
        JOIN joi_attachments a ON a.attachment_id = ia.attachment_id
       WHERE ia.input_id = ?
       ORDER BY a.created_at, a.attachment_id`).all(input.inputId)) as Record<string, unknown>[];
    if (rows.length === 0) return [];
    if (input.workId !== undefined && !/^[a-z0-9_-]+$/iu.test(input.workId)) throw new DomainError("work_attachment_staging_path_invalid", "Invalid task input directory identifier.");
    const inputRoot = input.workId === undefined ? input.workspacePath : path.join(this.dependencies.taskDirectory ?? path.join(os.tmpdir(), "joi-task-inputs"), input.workId);
    if (input.workId !== undefined) await mkdir(inputRoot, { recursive: true });
    const root = await realpath(inputRoot);
    const staged: StagedAttachment[] = [];
    for (const row of rows) {
      if (typeof row.attachment_id !== "string" || typeof row.filename !== "string") {
        throw new DomainError("joi_attachment_record_invalid", "A staged attachment row is invalid.");
      }
      const attachment = await this.dependencies.attachments.read(row.attachment_id);
      const target = path.resolve(root, "joi-attachments", row.attachment_id, attachment.filename);
      if (!target.startsWith(`${root}${path.sep}`)) {
        throw new DomainError("work_attachment_staging_path_invalid", "Attachment staging path escaped the workspace.");
      }
      const bytes = attachment.bytes;
      const digest = sha256(bytes);
      const existing = await readFile(target).catch(() => undefined);
      if (existing === undefined || sha256(existing) !== digest) {
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.tmp-${randomBytes(4).toString("hex")}`;
        await writeFile(temporary, bytes, { flag: "wx" });
        await rename(temporary, target);
      }
      staged.push({
        ...(input.workId === undefined ? {} : { readPath: target }),
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        relativePath: `joi-attachments/${row.attachment_id}/${attachment.filename}`,
        size: bytes.byteLength,
      });
    }
    return staged;
  }
}
