const WORKSPACE_PREFIX = "workspace:";

/** Internal-only reference; the full ref never crosses into a renderer DTO. */
export function workspaceArtifactReference(relativePath: string): string {
  return `${WORKSPACE_PREFIX}${relativePath}`;
}

export function workspaceArtifactRelativePath(reference: string | undefined): string | undefined {
  if (!reference?.startsWith(WORKSPACE_PREFIX)) return undefined;
  const relativePath = reference.slice(WORKSPACE_PREFIX.length);
  if (relativePath === "" || relativePath.includes("\\") || relativePath.includes("\0") || relativePath.startsWith("/")) return undefined;
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  if (/^[A-Za-z]:/u.test(relativePath)) return undefined;
  return relativePath;
}

/** POSIX dirname of a validated workspace-relative path; undefined for root-level entries. A validated relative dirname may cross into renderer DTOs for folder grouping. */
export function workspaceArtifactDirectory(relativePath: string): string | undefined {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? undefined : relativePath.slice(0, index);
}

export function workResultArtifactId(resultId: string, index: number): string {
  return `work_result_artifact:${resultId}:${String(index)}`;
}
