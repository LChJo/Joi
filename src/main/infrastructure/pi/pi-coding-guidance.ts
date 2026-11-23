import { WORKBENCH_HISTORY_TOOL } from "./pi-historical-memory-tools.js";

/** Host-owned guidance describes only capabilities present in this request. */
export function piCodingGuidance(toolNames: readonly string[], toolGuidelines: Readonly<Record<string, readonly string[]>> = {}): string[] {
  const enabled = new Set(toolNames),lines: string[] = [];
  if (enabled.has(WORKBENCH_HISTORY_TOOL)) lines.push(`Use ${WORKBENCH_HISTORY_TOOL} to read saved Workbench history. Call it without arguments to discover recent sources. Use the source reference in the Workbench evidence index exactly as returned. Set part to conclusion for a completed result and follow nextOffset until it is null. If a reference cannot be read, check the recent sources before reporting that the result is unavailable.`);
  if (enabled.has("grep")) lines.push("Use grep (ripgrep) for content searches. Start with a narrow path, glob and match limit. Combine independent patterns to avoid repeated whole-tree scans.");
  if (enabled.has("find")) lines.push("Use find (fd) for file-name and glob searches; start with the smallest relevant directory.");
  if (enabled.has("ls")) lines.push("Use ls for directory listings instead of recursive shell traversal.");
  if (enabled.has("read") && (toolGuidelines.read?.length ?? 0) === 0) lines.push("Use read to examine files instead of cat or sed. Request relevant ranges with offset and limit.");
  if (enabled.has("git_read")) lines.push("Use git_read for Git status, diff, log and commit inspection instead of bash.");
  if (enabled.has("bash")) lines.push("Use bash for builds, tests, scripts and necessary complex pipelines. For exploration, prefer the enabled dedicated tools. When a shell search is needed, bound it to relevant paths, honor ignore rules and avoid recursive grep at the repository root.");
  if (lines.length > 0) lines.push("Group independent exploration queries in the same model turn. Keep dependent queries ordered; report unavailable capabilities honestly and do not substitute a disabled tool.");
  return lines;
}
