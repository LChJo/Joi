/**
 * Authoritative workspace-root boundary shared by every partner engine runtime.
 * Work acceptance checks (FILE_EXISTS / FILE_CONTAINS_EXACT) resolve their relative
 * paths against the Work execution root and can never reference files outside it, so
 * the executing partner must be told that root explicitly: task text that calls another
 * directory (for example a repository checkout) the "workspace root" would otherwise
 * send deliverables somewhere verification cannot see.
 */
export function workspaceRootBoundaryLine(workspacePath: string | undefined): string {
  if (workspacePath === undefined) return "Workspace: unavailable; workspace tools are disabled.";
  return `Workspace root (authoritative): ${workspacePath}. Acceptance checks (FILE_EXISTS / FILE_CONTAINS_EXACT) resolve their relative paths against this root and can never reference files outside it, so every deliverable an acceptance check names must be created inside this root even when the task text calls another directory the workspace root.`;
}
