import { WORKBENCH_NAME_MAX_LENGTH, echoedWorkbenchSpan } from "../../../shared/workbench-suggestions.js";

export interface WorkbenchNamingContext {
  name: string;
  projectLabel?: string;
  scopeSummary?: string;
}

/** A proposed workbench, before it becomes one. Structurally a subset of the router's create decision. */
export interface ProposedWorkbench {
  name: string;
  projectLabel: string;
  scopeSummary: string;
}

/** Anything a label may carry after the cluster itself: 工坊 is the convention, the rest are older spellings. */
const CLUSTER_LABEL_SUFFIX_PATTERN = /(?:\s*(?:工作台|工坊|环境))+$/u;

/**
 * Why a proposed workbench is not a workbench, or null when it is one.
 *
 * A name lifted from the request reads as a workbench but behaves as a per-request folder: nothing
 * later can reuse it, so the next similar request mints another one beside it. This is the
 * deterministic half of that judgement — the router prompt asks for a cluster, and this refuses
 * the answer when it comes back as a restatement anyway.
 */
export function proposedWorkbenchRejection(input: string, draft: ProposedWorkbench): string | null {
  const stem = draft.name.trim().replace(CLUSTER_LABEL_SUFFIX_PATTERN, "").trim();
  if (stem.length === 0) return "workbench_name_empty";
  if (Array.from(stem).length > WORKBENCH_NAME_MAX_LENGTH) return "workbench_name_too_long";
  const projectName = draft.projectLabel.trim();
  const hasProjectName = /^[\p{L}\p{N}._-]{1,60}$/u.test(projectName) && draft.name.includes(projectName);
  const nameToCheck = hasProjectName ? draft.name.replaceAll(projectName, "") : draft.name;
  if (echoedWorkbenchSpan(nameToCheck, input) !== null) return "workbench_name_echoes_input";
  if (!hasProjectName && echoedWorkbenchSpan(draft.projectLabel, input) !== null) return "workbench_project_label_echoes_input";
  if (echoedWorkbenchSpan(draft.scopeSummary, input) !== null) return "workbench_scope_summary_echoes_input";
  return null;
}

const FRONTEND_DEBUG_PATTERN = /(?:前端|frontend)[\s\S]*(?:调试|debug)[\s\S]*(?:分析|analysis)?|(?:调试|debug)[\s\S]*(?:前端|frontend)[\s\S]*(?:分析|analysis)?/iu;
const ROLE_NAME_PATTERN = /(?:(?:资深|高级|senior|lead)\s*(?:程序员|工程师|开发者|developer|coder)|(?:程序员|工程师|开发者)\s*(?:搭档|partner))/iu;

/**
 * Workbench labels describe a durable work cluster/environment and are named 工坊
 * (partner cards are named 搭档, so the two surfaces stay tellable apart). A name
 * that already carries the suffix is kept as-is instead of double-suffixing.
 */
export function workbenchWorkspaceDisplayName(context: WorkbenchNamingContext): string {
  const searchable = [context.name, context.projectLabel, context.scopeSummary].filter((value): value is string => value !== undefined).join(" ");
  if (FRONTEND_DEBUG_PATTERN.test(searchable)) return "aimanadebug";
  const name = context.name.trim();
  if (name.length === 0) return "工坊";
  return name.endsWith("工坊") ? name : `${name} 工坊`;
}

/** Keep the user-facing cluster label as the final directory segment while rejecting path syntax. */
export function workspaceDirectoryName(displayName: string): string {
  const normalized = displayName.trim().normalize("NFKC").replace(/[\\/]+/gu, "-").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^[.-]+|[.-]+$/gu, "");
  return normalized.length === 0 ? "workbench" : normalized.slice(0, 80);
}

const WORKSHOP_SUFFIX_PATTERN = /工坊$/u;
const CLUSTER_SUFFIX_PATTERN = /(?:工坊|搭档)$/u;

/**
 * Agent cards use capability clusters named as 搭档; role/persona labels are too
 * narrow and duplicate Workbench scope, and 工坊-style labels belong to the
 * Workbench, not the partner card. A lingering 工坊 suffix (older prompts asked for
 * it) is normalized back to 搭档 so the convention holds whatever the model emits.
 */
export function partnerClusterName(displayName: string): string {
  const normalized = displayName.trim();
  if (ROLE_NAME_PATTERN.test(normalized)) return "编码搭档";
  return normalized.replace(WORKSHOP_SUFFIX_PATTERN, "搭档");
}

const QUOTED_SPAN_PATTERN = /「[^」]*」|『[^』]*』|“[^”]*”|‘[^’]*’|"[^"]*"|'[^']*'|\([^)]*\)|（[^）]*）|\[[^\]]*\]/gu;
const INSTANCE_TOKEN_PATTERN = /\b[a-z]+[._-]?\d+(?:\.\d+)*\b|\bv?\d+(?:\.\d+)+\b|\b\d+\b/giu;

/** Stable reuse key: strips one-off instance tokens (model names, version numbers, quoted/parenthetical notes) and the 工坊/搭档 cluster suffix so task-instance names — and pre-rename stored names — fall back to their capability cluster. */
export function partnerClusterKey(displayName: string): string {
  const compacted = partnerClusterName(displayName).replace(QUOTED_SPAN_PATTERN, " ").replace(INSTANCE_TOKEN_PATTERN, " ").replace(/\s+/gu, " ").trim();
  // Strip the cluster suffix last: quoted-span removal can leave a trailing space
  // that would otherwise block the end anchor.
  const key = compacted.replace(CLUSTER_SUFFIX_PATTERN, "").trim().toLocaleLowerCase();
  return key.length === 0 ? displayName.trim().toLocaleLowerCase() : key;
}
