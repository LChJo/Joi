import { createHash } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { JoiAttachmentDto } from "../../../shared/joi.js";
import type { Clock, IdGenerator } from "../../application/ports/runtime-store.js";
import { DomainError } from "../../domain/errors.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

const MAX_BYTES = 10 * 1024 * 1024;

export class JoiAttachmentService {
  constructor(private readonly dependencies: { clock: Clock; database: TransactionalDatabase; ids: IdGenerator; rootDirectory: string }) {}

  async upload(input: { bytes: Uint8Array; filename: string; mimeType: string }): Promise<JoiAttachmentDto> {
    this.#assertFilename(input.filename);
    if (input.bytes.byteLength > MAX_BYTES) throw new DomainError("attachment_too_large", "A message attachment cannot exceed 10 MiB.");
    const attachmentId = this.dependencies.ids.next("joi_attachment");
    const createdAt = this.dependencies.clock.now().toISOString();
    const relativePath = path.join("joi-attachments", `${attachmentId}.bin`);
    const root = path.resolve(this.dependencies.rootDirectory);
    await mkdir(path.join(root, "joi-attachments"), { recursive: true });
    const resolvedRoot = await realpath(root);
    const target = path.resolve(resolvedRoot, relativePath);
    if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new DomainError("attachment_path_invalid", "Attachment storage path is invalid.");
    await writeFile(target, input.bytes, { flag: "wx" });
    const mimeType = this.#mimeType(input.mimeType);
    try {
      this.dependencies.database.transaction((connection) => connection.prepare(`INSERT INTO joi_attachments
        (attachment_id, filename, mime_type, size, relative_path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        attachmentId, input.filename, mimeType, input.bytes.byteLength, relativePath,
        createHash("sha256").update(input.bytes).digest("hex"), createdAt,
      ));
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
    return { attachmentId, createdAt, filename: input.filename, mimeType, size: input.bytes.byteLength };
  }

  #assertFilename(filename: string): void {
    let control = false;
    for (let index = 0; index < filename.length; index += 1) {
      const code = filename.charCodeAt(index);
      if (code < 32 || code === 127) control = true;
    }
    if (filename.length === 0 || filename.length > 200 || filename !== path.basename(filename) || control) {
      throw new DomainError("attachment_filename_invalid", "Attachment filename is invalid.");
    }
  }

  #mimeType(value: string): string {
    const normalized = value.trim().toLowerCase();
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized) ? normalized : "application/octet-stream";
  }
}
