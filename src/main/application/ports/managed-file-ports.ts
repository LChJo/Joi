import type { A2aRequestPart } from "./a2a-ports.js";
import type { UserAttachmentRecord } from "./attachment-ports.js";

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
