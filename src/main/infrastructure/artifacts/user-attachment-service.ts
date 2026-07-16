import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { DomainError } from "../../domain/errors.js";
import type { A2aRequestPart } from "../../application/ports/a2a-ports.js";
import type { UserAttachmentRecord, UserAttachmentStore } from "../../application/ports/attachment-ports.js";
import type { Clock, IdGenerator } from "../../application/ports/runtime-store.js";

export const MAX_MESSAGE_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export type PublicUserAttachment = Pick<UserAttachmentRecord, "attachmentId" | "createdAt" | "filename" | "lifeId" | "mimeType" | "size">;

export class AttachmentService {
  constructor(private readonly dependencies: {
    clock: Clock;
    ids: IdGenerator;
    rootDirectory: string;
    store: UserAttachmentStore;
  }) {}

  async upload(input: { bytes: Uint8Array; filename: string; lifeId: string; mimeType: string }): Promise<PublicUserAttachment> {
    this.assertFilename(input.filename);
    if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new DomainError("attachment_too_large", "A message attachment cannot exceed 10 MiB.");
    }
    const mimeType = this.normalizeMimeType(input.mimeType);
    const attachmentId = this.dependencies.ids.next("attachment");
    const relativePath = path.join("user-attachments", `${attachmentId}.bin`);
    const root = path.resolve(this.dependencies.rootDirectory);
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    const resolvedRoot = await realpath(root);
    const target = path.resolve(resolvedRoot, relativePath);
    if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new DomainError("attachment_path_invalid", "Attachment storage path is invalid.");
    }
    await writeFile(target, input.bytes, { flag: "wx" });
    const record: UserAttachmentRecord = {
      attachmentId,
      createdAt: this.dependencies.clock.now().toISOString(),
      filename: input.filename,
      lifeId: input.lifeId,
      mimeType,
      relativePath,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      size: input.bytes.byteLength,
    };
    try {
      return this.toPublic(await this.dependencies.store.createUserAttachment(record));
    } catch (error) {
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async filePartsFromWake(payload: Record<string, unknown>): Promise<A2aRequestPart[]> {
    const lifeId = this.lifeIdFromWake(payload);
    const attachmentIds = this.attachmentIdsFromWake(payload);
    if (attachmentIds.length === 0) return [];
    if (lifeId === null) throw new DomainError("attachment_scope_invalid", "Wake attachment scope is missing a joi.");
    if (attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new DomainError("attachment_count_exceeded", "A message cannot forward more than 8 attachments.");
    }
    const parts: A2aRequestPart[] = [];
    let total = 0;
    for (const attachmentId of attachmentIds) {
      const attachment = await this.dependencies.store.getUserAttachment(attachmentId);
      if (attachment?.lifeId !== lifeId || attachment.eventId === undefined) {
        throw new DomainError("attachment_not_found", "A referenced message attachment is unavailable for this Life.");
      }
      total += attachment.size;
      if (attachment.size > MAX_ATTACHMENT_BYTES || total > MAX_MESSAGE_ATTACHMENT_BYTES) {
        throw new DomainError("attachment_size_exceeded", "Forwarded attachments exceed the 10 MiB per-file or 25 MiB total limit.");
      }
      const bytes = await this.readVerified(attachment);
      parts.push({ bytes: Buffer.from(bytes).toString("base64"), kind: "file", mimeType: attachment.mimeType, name: attachment.filename });
    }
    return parts;
  }

  private attachmentIdsFromWake(payload: Record<string, unknown>): string[] {
    if (!Array.isArray(payload.events)) return [];
    const ids: string[] = [];
    for (const event of payload.events) {
      if (event === null || Array.isArray(event) || typeof event !== "object") continue;
      const eventPayload = (event as Record<string, unknown>).payload;
      if (eventPayload === null || Array.isArray(eventPayload) || typeof eventPayload !== "object") continue;
      const attachments = (eventPayload as Record<string, unknown>).attachments;
      if (!Array.isArray(attachments)) continue;
      for (const item of attachments) {
        if (item === null || Array.isArray(item) || typeof item !== "object") continue;
        const attachmentId = (item as Record<string, unknown>).attachmentId;
        if (typeof attachmentId === "string" && !ids.includes(attachmentId)) ids.push(attachmentId);
      }
    }
    return ids;
  }

  private assertFilename(filename: string): void {
    let hasControlCharacter = false;
    for (let index = 0; index < filename.length; index += 1) {
      const code = filename.charCodeAt(index);
      if (code < 32 || code === 127) hasControlCharacter = true;
    }
    if (filename.length < 1 || filename.length > 200 || filename !== path.basename(filename) || hasControlCharacter) {
      throw new DomainError("attachment_filename_invalid", "Attachment filename must be a plain filename of at most 200 characters.");
    }
  }

  private lifeIdFromWake(payload: Record<string, unknown>): string | null {
    const life = payload.life;
    if (life === null || Array.isArray(life) || typeof life !== "object") return null;
    const lifeId = (life as Record<string, unknown>).lifeId;
    return typeof lifeId === "string" && lifeId !== "" ? lifeId : null;
  }

  private normalizeMimeType(mimeType: string): string {
    const normalized = mimeType.trim().toLowerCase();
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized) ? normalized : "application/octet-stream";
  }

  private async readVerified(attachment: UserAttachmentRecord): Promise<Uint8Array> {
    const root = await realpath(path.resolve(this.dependencies.rootDirectory));
    const candidate = path.resolve(root, attachment.relativePath);
    if (!candidate.startsWith(`${root}${path.sep}`)) throw new DomainError("attachment_integrity_failed", "Attachment path escaped managed storage.");
    const resolved = await realpath(candidate).catch(() => "");
    if (resolved === "" || !resolved.startsWith(`${root}${path.sep}`)) throw new DomainError("attachment_integrity_failed", "Attachment realpath validation failed.");
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size !== attachment.size) throw new DomainError("attachment_integrity_failed", "Attachment size or file type changed.");
    const bytes = await readFile(resolved);
    if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new DomainError("attachment_integrity_failed", "Attachment hash validation failed.");
    return bytes;
  }

  private toPublic(record: UserAttachmentRecord): PublicUserAttachment {
    return {
      attachmentId: record.attachmentId,
      createdAt: record.createdAt,
      filename: record.filename,
      lifeId: record.lifeId,
      mimeType: record.mimeType,
      size: record.size,
    };
  }
}
