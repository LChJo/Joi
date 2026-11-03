import { mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { DomainError } from "../../domain/errors.js";
import type { A2aResultStore } from "../../application/ports/a2a-ports.js";
import type { UserAttachmentStore } from "../../application/ports/attachment-ports.js";
import type { IdGenerator } from "../../application/ports/runtime-store.js";
import type { LifeFileDeletionPort, StagedLifeFileDeletion } from "../../application/ports/life-file-ports.js";

export class LifeFileDeletionService implements LifeFileDeletionPort {
  constructor(private readonly dependencies: {
    ids: IdGenerator;
    rootDirectory: string;
    store: Pick<A2aResultStore, "listLifeArtifacts"> & Pick<UserAttachmentStore, "listLifeUserAttachments">;
  }) {}

  async stage(lifeId: string): Promise<StagedLifeFileDeletion> {
    const [artifacts, attachments] = await Promise.all([
      this.dependencies.store.listLifeArtifacts(lifeId),
      this.dependencies.store.listLifeUserAttachments(lifeId),
    ]);
    const relativePaths = [...new Set([
      ...artifacts.flatMap((artifact) => artifact.relativePath === undefined ? [] : [artifact.relativePath]),
      ...attachments.map((attachment) => attachment.relativePath),
    ])];
    const rootPath = path.resolve(this.dependencies.rootDirectory);
    await mkdir(rootPath, { recursive: true });
    const root = await realpath(rootPath);
    const quarantineDirectory = path.resolve(root, ".deletion-quarantine", this.dependencies.ids.next("life-delete"));
    if (!quarantineDirectory.startsWith(`${root}${path.sep}`)) throw new DomainError("life_file_path_invalid", "Life deletion quarantine path is invalid.");
    const moves: StagedLifeFileDeletion["moves"] = [];
    if (relativePaths.length === 0) return { moves, quarantineDirectory };
    await mkdir(quarantineDirectory, { recursive: true });
    try {
      for (const [index, relativePath] of relativePaths.entries()) {
        const candidate = path.resolve(root, relativePath);
        if (!candidate.startsWith(`${root}${path.sep}`)) throw new DomainError("life_file_path_invalid", "A managed Life file path escaped storage.");
        const source = await realpath(candidate).catch(() => "");
        if (source === "") continue;
        if (!source.startsWith(`${root}${path.sep}`)) throw new DomainError("life_file_path_invalid", "A managed Life file failed realpath validation.");
        const destination = path.join(quarantineDirectory, `${String(index).padStart(4, "0")}.managed`);
        await rename(source, destination);
        moves.push({ destination, source });
      }
      return { moves, quarantineDirectory };
    } catch (error) {
      await this.rollback({ moves, quarantineDirectory });
      throw error;
    }
  }

  async commit(plan: StagedLifeFileDeletion): Promise<void> {
    await this.assertQuarantine(plan.quarantineDirectory);
    await rm(plan.quarantineDirectory, { force: true, recursive: true });
  }

  async rollback(plan: StagedLifeFileDeletion): Promise<void> {
    await this.assertQuarantine(plan.quarantineDirectory);
    for (const move of [...plan.moves].reverse()) {
      await mkdir(path.dirname(move.source), { recursive: true });
      await rename(move.destination, move.source).catch(() => undefined);
    }
    await rm(plan.quarantineDirectory, { force: true, recursive: true });
  }

  private async assertQuarantine(quarantineDirectory: string): Promise<void> {
    const root = await realpath(path.resolve(this.dependencies.rootDirectory));
    const expectedParent = path.resolve(root, ".deletion-quarantine");
    if (quarantineDirectory === expectedParent || !quarantineDirectory.startsWith(`${expectedParent}${path.sep}`)) {
      throw new DomainError("life_file_path_invalid", "Life deletion quarantine escaped managed storage.");
    }
  }
}
