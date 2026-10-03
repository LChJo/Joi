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

/**
 * The read half of the workspace boundary, stated as a permission rather than an exception.
 *
 * The boundary only ever confined writes (see pi-filesystem-boundary.ts for why reads pass
 * through), but the prompt buried that fact mid-paragraph among four prohibitions — "the only
 * place your file tools will write … do not plan work that depends on it …" — and partners
 * generalized it into a global no-outside-access rule: a delivered report recorded skipping a
 * reference tree it was entitled to read with "不在工作区；按约束未去区外寻找". The read
 * permission therefore leads its own sentence, names no prohibition, and the write confinement
 * is what gets the qualifier.
 */
export function workspaceReadScopeLine(): string {
  return "Reads are never confined: you can read any path on this machine — inside or outside the workspace — with your read tools or shell commands, and reading requires no permission; examine reference repositories, user directories, installed skill folders, and configuration files freely. Only file writes are governed by the workspace boundary.";
}
