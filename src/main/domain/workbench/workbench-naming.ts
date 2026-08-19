export interface WorkbenchNamingContext {
  name: string;
  projectLabel?: string;
  scopeSummary?: string;
}

const FRONTEND_DEBUG_PATTERN = /(?:前端|frontend)[\s\S]*(?:调试|debug)[\s\S]*(?:分析|analysis)?|(?:调试|debug)[\s\S]*(?:前端|frontend)[\s\S]*(?:分析|analysis)?/iu;
const ROLE_NAME_PATTERN = /(?:(?:资深|高级|senior|lead)\s*(?:程序员|工程师|开发者|developer|coder)|(?:程序员|工程师|开发者)\s*(?:搭档|partner))/iu;

/** Workbench labels describe a durable work cluster/environment, not a partner role. */
export function workbenchWorkspaceDisplayName(context: WorkbenchNamingContext): string {
  const searchable = [context.name, context.projectLabel, context.scopeSummary].filter((value): value is string => value !== undefined).join(" ");
  if (FRONTEND_DEBUG_PATTERN.test(searchable)) return "aimanadebug";
  const name = context.name.trim();
  return name.length === 0 ? "工作区" : `${name} 工作区`;
}

/** Keep the user-facing cluster label as the final directory segment while rejecting path syntax. */
export function workspaceDirectoryName(displayName: string): string {
  const normalized = displayName.trim().normalize("NFKC").replace(/[\\/]+/gu, "-").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^[.-]+|[.-]+$/gu, "");
  return normalized.length === 0 ? "workbench" : normalized.slice(0, 80);
}

/** Agent cards use capability clusters; role/persona labels are too narrow and duplicate Workbench scope. */
export function partnerClusterName(displayName: string): string {
  const normalized = displayName.trim();
  return ROLE_NAME_PATTERN.test(normalized) ? "编码工坊" : normalized;
}

const QUOTED_SPAN_PATTERN = /「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|\([^)]*\)|（[^）]*）|\[[^\]]*\]/gu;
const INSTANCE_TOKEN_PATTERN = /\b[a-z]+[._-]?\d+(?:\.\d+)*\b|\bv?\d+(?:\.\d+)+\b|\b\d+\b/giu;

/** Stable reuse key: strips one-off instance tokens (model names, version numbers, quoted/parenthetical notes) so task-instance names fall back to their capability cluster. */
export function partnerClusterKey(displayName: string): string {
  const key = partnerClusterName(displayName).replace(QUOTED_SPAN_PATTERN, " ").replace(INSTANCE_TOKEN_PATTERN, " ").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  return key.length === 0 ? displayName.trim().toLocaleLowerCase() : key;
}
