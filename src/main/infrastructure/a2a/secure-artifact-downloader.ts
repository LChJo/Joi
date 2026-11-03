import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactDownloader } from "../../application/ports/a2a-ports.js";
import { ArtifactPolicy } from "../../domain/a2a/artifact-policy.js";
import { DomainError } from "../../domain/errors.js";
import type { OutboundNetworkPolicy } from "./outbound-network-policy.js";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export class SecureArtifactDownloader implements ArtifactDownloader {
  private readonly artifactPolicy = new ArtifactPolicy();

  constructor(private readonly dependencies: { fetchImpl?: typeof fetch; policy: OutboundNetworkPolicy; rootDirectory: string }) {}

  async download(input: {
    artifactId: string;
    declaredOrigin: string;
    filename: string;
    invocationId: string;
    mimeType: string;
    size: number;
    token: string;
    url: string;
  }): Promise<{ relativePath: string; sha256: string; size: number }> {
    if (!SAFE_ID.test(input.invocationId) || !SAFE_ID.test(input.artifactId)) {
      throw new DomainError("artifact_rejected", "Artifact identifiers are invalid.");
    }
    const artifact = this.artifactPolicy.validate(input);
    const root = path.resolve(this.dependencies.rootDirectory);
    await mkdir(root, { recursive: true });
    const disk = await statfs(root);
    if (disk.bavail * disk.bsize < Math.max(256 * 1024 * 1024, input.size * 2)) {
      throw new DomainError("storage_low", "Artifact download is paused because disk space is low.");
    }
    const response = await this.fetchFollowingRedirects(artifact.url, input.declaredOrigin, input.token);
    if (!response.ok) throw new DomainError("artifact_rejected", "Artifact download failed.");
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) throw new DomainError("artifact_rejected", "Artifact exceeds the 100 MiB automatic download limit.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_FILE_BYTES || (input.size > 0 && bytes.byteLength !== input.size)) {
      throw new DomainError("artifact_rejected", "Artifact size does not match the task declaration.");
    }

    const directory = path.resolve(root, input.invocationId);
    if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) throw new DomainError("artifact_rejected", "Artifact storage path escapes its root.");
    await mkdir(directory, { recursive: true });
    const resolvedRoot = await realpath(root);
    const resolvedDirectory = await realpath(directory);
    if (resolvedDirectory !== resolvedRoot && !resolvedDirectory.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new DomainError("artifact_rejected", "Artifact storage path escapes its real root.");
    }
    const finalPath = path.join(resolvedDirectory, `${input.artifactId}-${artifact.filename}`);
    const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx" });
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    return {
      relativePath: path.relative(resolvedRoot, finalPath).replaceAll(path.sep, "/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  }

  private async fetchFollowingRedirects(url: string, origin: string, token: string): Promise<Response> {
    const fetchImpl = this.dependencies.fetchImpl ?? fetch;
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const validated = await this.dependencies.policy.validate(current);
      if (validated.origin !== origin) throw new DomainError("artifact_rejected", "Artifact redirect changed Origin.");
      const response = await fetchImpl(validated.url, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(5 * 60_000),
      });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (location === null) throw new DomainError("artifact_rejected", "Artifact redirect is missing Location.");
      current = (await this.dependencies.policy.validateRedirect({ bearerOrigin: origin, from: current, location })).url;
    }
    throw new DomainError("artifact_rejected", "Artifact redirect limit exceeded.");
  }
}
