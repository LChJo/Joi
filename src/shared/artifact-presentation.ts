import type { WorkbenchArtifactDto } from "./joi.js";

const HIDDEN_DIRECTORIES = new Set(["node_modules", "__pycache__"]);

/** VCS/dependency metadata is never a deliverable; hidden from every artifact surface, including persisted rows. */
export function isHiddenWorkspaceArtifact(artifact: Pick<WorkbenchArtifactDto, "directory">): boolean {
  return artifact.directory?.split("/").some(segment => segment.startsWith(".") || HIDDEN_DIRECTORIES.has(segment)) ?? false;
}

/** Label for the folder group holding workspace-root or directory-unknown files. */
export const ARTIFACT_ROOT_LABEL = "（工作区根目录）";

/** Every file type can stand alone when its directory contains at most three changed files. */
export function isIndividuallyRenderedArtifact(artifact: Pick<WorkbenchArtifactDto, "kind" | "mimeType" | "name">): boolean {
  return artifact.kind === "FILE";
}

export function artifactGroupLabel(directory: string | undefined, rootLabel = ARTIFACT_ROOT_LABEL): string {
  return directory === undefined || directory === "" ? rootLabel : directory;
}

export type ArtifactRenderGroup<T> =
  | { kind: "SINGLE"; item: T }
  | { kind: "FOLDER"; directory: string | undefined; items: T[] };

/**
 * A directory with more than three files is one row, independent of MIME type or interleaved
 * directory markers. Conversation messages delimit artifact blocks and keep their order.
 */
export function groupArtifactsForDisplay<T>(items: readonly T[], artifactOf: (item: T) => WorkbenchArtifactDto | undefined): ArtifactRenderGroup<T>[] {
  const groups: ArtifactRenderGroup<T>[] = [];
  let block: T[] = [];
  const flush = (): void => {
    const directories = new Map<string, T[]>();
    for (const item of block) {
      const artifact = artifactOf(item);
      if (artifact?.kind !== "FILE") continue;
      const directory = artifact.directory ?? "";
      const files = directories.get(directory) ?? [];
      files.push(item); directories.set(directory, files);
    }
    const shown = new Set<string>();
    for (const item of block) {
      const artifact = artifactOf(item);
      if (artifact === undefined) continue;
      const directory = artifact.directory ?? "";
      const files = directories.get(directory);
      if (artifact.kind === "DIRECTORY") {
        if (artifact.fileCount !== undefined || artifact.directory === undefined || files === undefined) groups.push({ kind: "SINGLE", item });
      } else if (files !== undefined && files.length > 3) {
        if (!shown.has(directory)) groups.push({ kind: "FOLDER", directory: directory === "" ? undefined : directory, items: files });
        shown.add(directory);
      } else groups.push({ kind: "SINGLE", item });
    }
    block = [];
  };
  for (const item of items) {
    const artifact = artifactOf(item);
    if (artifact === undefined) { flush(); groups.push({ kind: "SINGLE", item }); continue; }
    if (isHiddenWorkspaceArtifact(artifact)) continue;
    block.push(item);
  }
  flush();
  return groups;
}
