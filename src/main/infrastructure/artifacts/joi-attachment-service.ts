import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import type { JoiAttachmentDto } from "../../../shared/joi.js";
import type { Clock, IdGenerator } from "../../application/ports/runtime-store.js";
import { DomainError } from "../../domain/errors.js";
import type { BitmapTranscodeInput, BitmapTranscodeResult } from "./bitmap-transcoder.js";

interface TransactionalDatabase {
  transaction<T>(operation: (database: DatabaseSync) => T): T;
}

const MAX_BYTES = 10 * 1024 * 1024;

const IMPORTABLE_IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export class JoiAttachmentService {
  constructor(private readonly dependencies: {
    clock: Clock;
    database: TransactionalDatabase;
    ids: IdGenerator;
    rootDirectory: string;
    /** Normalizes clipboard bitmaps before storage; absent in unit tests without Electron. */
    transcodeBitmap?: (input: BitmapTranscodeInput) => BitmapTranscodeResult | undefined;
  }) {}

  async upload(input: { bytes: Uint8Array; filename: string; mimeType: string }): Promise<JoiAttachmentDto> {
    this.#assertFilename(input.filename);
    // Transcode before the size check: a 10+ MiB uncompressed BMP typically
    // collapses well under the limit once re-encoded as PNG.
    const transcoded = this.dependencies.transcodeBitmap?.({
      bytes: input.bytes, filename: input.filename, mimeType: this.#mimeType(input.mimeType),
    });
    const bytes = transcoded?.bytes ?? input.bytes;
    const filename = transcoded?.filename ?? input.filename;
    const declaredMimeType = transcoded === undefined ? this.#mimeType(input.mimeType) : transcoded.mimeType;
    if (bytes.byteLength > MAX_BYTES) throw new DomainError("attachment_too_large", "A message attachment cannot exceed 10 MiB.");
    const attachmentId = this.dependencies.ids.next("joi_attachment");
    const createdAt = this.dependencies.clock.now().toISOString();
    const relativePath = path.join("joi-attachments", `${attachmentId}.bin`);
    const root = path.resolve(this.dependencies.rootDirectory);
    await mkdir(path.join(root, "joi-attachments"), { recursive: true });
    const resolvedRoot = await realpath(root);
    const target = path.resolve(resolvedRoot, relativePath);
    if (!target.startsWith(`${resolvedRoot}${path.sep}`)) throw new DomainError("attachment_path_invalid", "Attachment storage path is invalid.");
    await writeFile(target, bytes, { flag: "wx" });
    try {
      this.dependencies.database.transaction((connection) => connection.prepare(`INSERT INTO joi_attachments
        (attachment_id, filename, mime_type, size, relative_path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        attachmentId, filename, declaredMimeType, bytes.byteLength, relativePath,
        createHash("sha256").update(bytes).digest("hex"), createdAt,
      ));
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
    return { attachmentId, createdAt, filename, mimeType: declaredMimeType, size: bytes.byteLength };
  }

  /**
   * Imports a local image file (e.g. a Codux clipboard-paste path) as a regular
   * attachment. Restricted to image extensions so the endpoint cannot be used
   * to pull arbitrary documents into the attachment store; bitmap inputs flow
   * through the same transcode path as uploads.
   */
  async importPath(input: { path: string }): Promise<JoiAttachmentDto> {
    if (!path.isAbsolute(input.path)) throw new DomainError("attachment_import_path_invalid", "An imported attachment path must be absolute.");
    const extension = path.extname(input.path).toLowerCase();
    const mimeType = IMPORTABLE_IMAGE_MIME_TYPES[extension];
    if (mimeType === undefined) throw new DomainError("attachment_import_not_image", "Only image files can be imported as attachments.");
    const metadata = await stat(input.path).catch(() => undefined);
    if (metadata?.isFile() !== true) throw new DomainError("attachment_import_not_found", "The referenced image file does not exist.");
    const bytes = new Uint8Array(await readFile(input.path));
    return this.upload({ bytes, filename: path.basename(input.path), mimeType });
  }

  async read(attachmentId: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }> {
    const row = this.dependencies.database.transaction((connection) => connection.prepare(
      "SELECT filename, mime_type, size, relative_path, sha256 FROM joi_attachments WHERE attachment_id = ?",
    ).get(attachmentId)) as { filename?: unknown; mime_type?: unknown; relative_path?: unknown; sha256?: unknown; size?: unknown } | undefined;
    if (row === undefined || typeof row.filename !== "string" || typeof row.mime_type !== "string"
      || typeof row.size !== "number" || typeof row.relative_path !== "string" || typeof row.sha256 !== "string") {
      throw new DomainError("joi_attachment_not_found", "A referenced joi attachment is unavailable.");
    }
    const root = await realpath(path.resolve(this.dependencies.rootDirectory));
    const candidate = path.resolve(root, row.relative_path);
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new DomainError("joi_attachment_integrity_failed", "Attachment path escaped managed storage.");
    const resolved = await realpath(candidate).catch(() => "");
    if (resolved === "" || !resolved.startsWith(`${root}${path.sep}`)) throw new DomainError("joi_attachment_integrity_failed", "Attachment realpath validation failed.");
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size !== row.size) throw new DomainError("joi_attachment_integrity_failed", "Attachment size or file type changed.");
    const bytes = new Uint8Array(await readFile(resolved));
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new DomainError("joi_attachment_integrity_failed", "Attachment hash validation failed.");
    return { bytes, filename: row.filename, mimeType: row.mime_type };
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
