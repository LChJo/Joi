import type { WorkbenchArtifactDto } from "./joi.js";

const DOC_MIME_TYPES = new Set(["text/markdown", "text/plain"]);
const DOC_EXTENSIONS = new Set([".md", ".txt"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"]);
const HIDDEN_ROOT_DIRECTORIES = new Set([".git", "node_modules"]);

/** VCS/dependency metadata is never a deliverable; hidden from every artifact surface, including persisted rows. */
export function isHiddenWorkspaceArtifact(artifact: Pick<WorkbenchArtifactDto, "directory">): boolean {
  if (artifact.directory === undefined) return false;
  const [head] = artifact.directory.split("/");
  return HIDDEN_ROOT_DIRECTORIES.has(head ?? artifact.directory);
}

/** Label for the folder group holding workspace-root or directory-unknown files. */
export const ARTIFACT_ROOT_LABEL = "（工作区根目录）";

/** Documents (markdown/plain text) and images keep individual cards; everything else merges into folder rows. */
export function isIndividuallyRenderedArtifact(artifact: Pick<WorkbenchArtifactDto, "kind" | "mimeType" | "name">): boolean {
  if (artifact.kind === "DIRECTORY") return false;
  const [head] = artifact.mimeType.split(";");
  const mime = (head ?? "").trim().toLowerCase();
  if (DOC_MIME_TYPES.has(mime)) return true;
  const dot = artifact.name.lastIndexOf(".");
  const extension = dot === -1 ? "" : artifact.name.slice(dot).toLowerCase();
  return DOC_EXTENSIONS.has(extension) || IMAGE_EXTENSIONS.has(extension);
}

export function artifactGroupLabel(directory: string | undefined, rootLabel = ARTIFACT_ROOT_LABEL): string {
  return directory === undefined || directory === "" ? rootLabel : directory;
}

export type ArtifactRenderGroup<T> =
  | { kind: "SINGLE"; item: T }
  | { kind: "FOLDER"; directory: string | undefined; items: T[] };

/**
 * Folds an ordered list into render groups: whitelisted artifacts stay SINGLE in place,
 * consecutive non-whitelisted FILE artifacts fold into one FOLDER row per directory, and
 * DIRECTORY artifacts whose path equals a formed group key are suppressed (the group row
 * represents them). Items whose artifactOf returns undefined pass through as SINGLE and
 * break folder runs.
 */
export function groupArtifactsForDisplay<T>(items: readonly T[], artifactOf: (item: T) => WorkbenchArtifactDto | undefined): ArtifactRenderGroup<T>[] {
  const groupedDirectories = new Set<string>();
  for (const item of items) {
    const artifact = artifactOf(item);
    if (artifact === undefined || isHiddenWorkspaceArtifact(artifact)) continue;
    if (artifact.kind !== "FILE" || isIndividuallyRenderedArtifact(artifact)) continue;
    groupedDirectories.add(artifact.directory ?? "");
  }
  const groups: ArtifactRenderGroup<T>[] = [];
  let current: { directory: string; items: T[] } | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    groups.push({ kind: "FOLDER", directory: current.directory === "" ? undefined : current.directory, items: current.items });
    current = undefined;
  };
  for (const item of items) {
    const artifact = artifactOf(item);
    if (artifact === undefined) { flush(); groups.push({ kind: "SINGLE", item }); continue; }
    if (isHiddenWorkspaceArtifact(artifact)) continue;
    if (artifact.kind === "FILE" && !isIndividuallyRenderedArtifact(artifact)) {
      const directory = artifact.directory ?? "";
      if (current?.directory === directory) current.items.push(item);
      else { flush(); current = { directory, items: [item] }; }
      continue;
    }
    if (artifact.kind === "DIRECTORY" && groupedDirectories.has(artifact.directory ?? "")) continue;
    flush();
    groups.push({ kind: "SINGLE", item });
  }
  flush();
  return groups;
}
