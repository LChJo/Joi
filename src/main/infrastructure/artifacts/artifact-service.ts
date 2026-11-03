import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { ArtifactRecord, A2aResultStore } from "../../application/ports/a2a-ports.js";
import { DomainError } from "../../domain/errors.js";

const PREVIEW_MIME = new Set([
  "application/json",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
]);

export interface ArtifactContent {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export class ArtifactService {
  constructor(private readonly dependencies: {
    rootDirectory: string;
    store: Pick<A2aResultStore, "getArtifact">;
  }) {}

  async read(input: { artifactId: string; lifeId: string; preview: boolean }): Promise<ArtifactContent> {
    const artifact = await this.dependencies.store.getArtifact(input.artifactId);
    if (artifact?.lifeId !== input.lifeId) {
      throw new DomainError("artifact_not_found", "Artifact was not found for this Life.");
    }
    if (input.preview && !this.previewAllowed(artifact)) {
      throw new DomainError("artifact_preview_unsupported", "This Artifact type cannot be safely previewed.");
    }
    if (artifact.relativePath === undefined || artifact.sha256 === undefined) {
      throw new DomainError("artifact_content_unavailable", "Artifact content is not available in managed storage.");
    }
    const root = await realpath(path.resolve(this.dependencies.rootDirectory));
    const candidate = path.resolve(root, artifact.relativePath);
    if (candidate === root || !candidate.startsWith(`${root}${path.sep}`)) {
      throw new DomainError("artifact_integrity_failed", "Artifact storage path is invalid.");
    }
    const resolved = await realpath(candidate).catch(() => "");
    if (resolved === "" || !resolved.startsWith(`${root}${path.sep}`)) {
      throw new DomainError("artifact_integrity_failed", "Artifact storage path failed realpath validation.");
    }
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size !== artifact.size) {
      throw new DomainError("artifact_integrity_failed", "Artifact size or file type no longer matches its record.");
    }
    const bytes = await readFile(resolved);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      throw new DomainError("artifact_integrity_failed", "Artifact hash validation failed.");
    }
    return {
      bytes,
      filename: artifact.filename,
      mimeType: input.preview && artifact.mimeType === "text/markdown" ? "text/plain; charset=utf-8" : artifact.mimeType,
    };
  }

  private previewAllowed(artifact: ArtifactRecord): boolean {
    return artifact.mimeType.startsWith("text/") || PREVIEW_MIME.has(artifact.mimeType);
  }
}
