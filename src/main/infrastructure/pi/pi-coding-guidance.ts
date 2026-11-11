/** Host-owned guidance describes only capabilities present in this request. */
export function piCodingGuidance(toolNames: readonly string[]): string[] {
  const enabled = new Set(toolNames),lines: string[] = [];
  if (enabled.has("grep")) lines.push("Use grep (ripgrep) for content searches; narrow the path and glob, and combine independent patterns where useful.");
  if (enabled.has("find")) lines.push("Use find (fd) for file-name and glob searches; start with the smallest relevant directory.");
  if (enabled.has("ls")) lines.push("Use ls for directory listings instead of recursive shell traversal.");
  if (enabled.has("read")) lines.push("Use read to examine files instead of cat or sed. Request relevant ranges with offset and limit.");
  if (enabled.has("bash")) lines.push("Use bash for builds, tests, scripts and necessary complex pipelines. For exploration, prefer the enabled dedicated tools; use permitted shell alternatives when a dedicated capability is unavailable.");
  if (lines.length > 0) lines.push("Group independent exploration queries in the same model turn. Keep dependent queries ordered; report unavailable capabilities honestly and do not substitute a disabled tool.");
  return lines;
}
