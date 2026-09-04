import type { JoiAttachmentDto } from "../../../shared/joi.js";

export interface ArtifactReadPort {
  read(input: { artifactId: string; lifeId: string; preview: boolean }): Promise<{
    bytes: Uint8Array;
    filename: string;
    mimeType: string;
  }>;
}

export interface JoiAttachmentPort {
  read(attachmentId: string): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  upload(input: { bytes: Uint8Array; filename: string; mimeType: string }): Promise<JoiAttachmentDto>;
}
