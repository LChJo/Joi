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
  /** Reads a local image file by absolute path and stores it as a regular attachment. */
  importPath(input: { path: string }): Promise<JoiAttachmentDto>;
  upload(input: { bytes: Uint8Array; filename: string; mimeType: string }): Promise<JoiAttachmentDto>;
}
