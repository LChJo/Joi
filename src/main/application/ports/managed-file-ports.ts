import type { A2aRequestPart } from "./a2a-ports.js";
import type { UserAttachmentRecord } from "./attachment-ports.js";
import type { JoiAttachmentDto } from "../../../shared/joi.js";

export interface ArtifactReadPort {
  read(input: { artifactId: string; lifeId: string; preview: boolean }): Promise<{
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
  }>;
}

export interface UserAttachmentPort {
  filePartsFromWake(payload: Record<string, unknown>): Promise<A2aRequestPart[]>;
  upload(input: { bytes: Uint8Array; filename: string; lifeId: string; mimeType: string }): Promise<
    Pick<UserAttachmentRecord, "attachmentId" | "createdAt" | "filename" | "lifeId" | "mimeType" | "size">
  >;
}

export interface JoiAttachmentPort {
  read(attachmentId: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  upload(input: { bytes: Uint8Array; filename: string; mimeType: string }): Promise<JoiAttachmentDto>;
}
