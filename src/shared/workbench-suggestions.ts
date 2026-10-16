/**
 * Shared advisory ranking for workbench candidates. Keyword overlap orders options for a user;
 * it never authorizes automatic routing or creation. Proposals describe durable work scopes.
 */

/** A workbench as the matcher sees it. Kept structural so main and renderer can both pass their own DTOs. */
export interface WorkbenchMatchSource {
  name: string;
  scopeSummary: string;
  workbenchId: string;
}

export interface WorkbenchMatch {
  score: number;
  workbench: WorkbenchMatchSource;
}

export interface WorkbenchSuggestion {
  /** `existing` reuses the workbench; `template` asks joi to create the described cluster. */
  description: string;
  kind: "existing" | "template";
  name: string;
  personaSummary: string;
  projectLabel: string;
  scopeSummary: string;
  /** Present for `existing` only — reuse this workbench instead of creating a new one. */
  workbenchId?: string;
}

/**
 * How many candidates the hand-pick list offers. Three is the number the card has always shown.
 */
export const WORKBENCH_SUGGESTION_LIMIT = 3;

/** Below this many shared terms an overlap is a coincidence, not a subject. */
const MIN_SHARED_TERMS = 2;

/** Advisory overlap label for candidate comparison; automatic routing requires a semantic scope decision. */
export const WORKBENCH_MATCH_CONFIDENT_SCORE = 0.1;
/** Softer bar for merely *offering* an existing workbench in the hand-pick list. */
export const WORKBENCH_MATCH_CANDIDATE_SCORE = 0.08;
/** Two workbenches this close together and both this plausible mean the input straddles them: ask, don't guess. */
export const WORKBENCH_MATCH_AMBIGUOUS_MARGIN = 0.03;

/** A candidate carrying this many consecutive characters of the input is a restatement, not an abstraction. */
export const WORKBENCH_ECHO_SPAN = 12;
/** A shorter stem that appears verbatim in the input is still a restatement (the observed truncation case). */
export const WORKBENCH_ECHO_STEM = 6;
/**
 * A cluster name longer than this has stopped describing a cluster. Set above the longest label
 * in real use (versioned project names run long) so it only catches a model dumping a sentence;
 * the verbatim-span check, not this, is what rejects a restatement.
 */
export const WORKBENCH_NAME_MAX_LENGTH = 30;
/** Echo scanning stays bounded on pathologically long inputs; a name copying from beyond this is still an echo. */
const ECHO_SCAN_LIMIT = 4_000;

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_RUN = /[a-z0-9]+/gu;
/** Punctuation, whitespace and the placeholder ellipsis a truncated name carries. */
const NOISE = /[\s\p{P}\p{S}]/gu;

/**
 * Comparison form: compatibility-normalized, case-folded, and stripped of punctuation and
 * whitespace so 「宁国·皖南川藏线」 and "宁国 皖南川藏线" compare equal.
 */
export function compactWorkbenchText(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(NOISE, "");
}

/**
 * Overlapping bigrams plus latin/digit words. Bigrams are what make Chinese comparison work
 * without a segmenter: 「行程规划」 and 「规划行程」 share 行程/程规/规划.
 *
 * Windows are taken over the compacted text and kept only when one side is CJK, so a mixed run
 * like "A股" survives as one term while two unrelated latin words cannot match on shared letters.
 */
export function workbenchMatchTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const run of text.normalize("NFKC").toLocaleLowerCase().match(LATIN_RUN) ?? []) {
    if (run.length >= 2) terms.add(run);
  }
  const compacted = compactWorkbenchText(text);
  for (let index = 0; index + 2 <= compacted.length; index += 1) {
    const window = compacted.slice(index, index + 2);
    if (CJK_CHAR.test(window)) terms.add(window);
  }
  return terms;
}

/**
 * Terms both sides share, or 0 when the overlap is too thin to mean anything.
 *
 * One shared term is how 「技术研究」 and 「研究一下这个」 would match on 研究 alone; across a
 * workbench catalog that is a coincidence, not a subject.
 */
function sharedTerms(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const term of left) if (right.has(term)) shared += 1;
  return shared >= MIN_SHARED_TERMS ? shared : 0;
}

/**
 * How much of a field the input covers, from 0 to 1.
 *
 * Coverage, not Jaccard: a workbench whose scope blurb is three sentences long is not a worse
 * match than a terse one, and dividing by the union made it one. The denominator is the smaller
 * side, so a short field fully quoted by the input reads as the strong signal it is.
 */
export function workbenchMatchScore(input: string, workbench: WorkbenchMatchSource): number {
  const inputTerms = workbenchMatchTerms(input);
  if (inputTerms.size === 0) return 0;
  const coverage = (field: string): number => {
    const fieldTerms = workbenchMatchTerms(field);
    if (fieldTerms.size === 0) return 0;
    return sharedTerms(inputTerms, fieldTerms) / Math.min(inputTerms.size, fieldTerms.size);
  };
  // The name carries more signal than the scope blurb, which is prose and matches loosely.
  return (coverage(workbench.name) * 2 + coverage(workbench.scopeSummary)) / 3;
}

/** Best first. Ties break on workbenchId so the ranking is stable across processes. */
export function rankWorkbenchMatches(input: string, workbenches: readonly WorkbenchMatchSource[]): WorkbenchMatch[] {
  return workbenches
    .map((workbench) => ({ score: workbenchMatchScore(input, workbench), workbench }))
    .sort((left, right) => right.score - left.score || left.workbench.workbenchId.localeCompare(right.workbench.workbenchId));
}

export type WorkbenchMatchVerdict =
  | { kind: "none" }
  | { kind: "confident"; match: WorkbenchMatch }
  /** Two scopes both plausibly hold this input. This advisory result never authorizes automatic assignment. */
  | { kind: "ambiguous"; matches: [WorkbenchMatch, WorkbenchMatch] };

export function judgeWorkbenchMatch(input: string, workbenches: readonly WorkbenchMatchSource[]): WorkbenchMatchVerdict {
  const [first, second] = rankWorkbenchMatches(input, workbenches);
  if (first === undefined || first.score < WORKBENCH_MATCH_CONFIDENT_SCORE) return { kind: "none" };
  // Both have to clear the confidence bar on their own: a strong match beside a weak one is not
  // a dilemma, it is a match with a near-miss next to it.
  if (second !== undefined && second.score >= WORKBENCH_MATCH_CONFIDENT_SCORE
    && first.score - second.score < WORKBENCH_MATCH_AMBIGUOUS_MARGIN) {
    return { kind: "ambiguous", matches: [first, second] };
  }
  return { kind: "confident", match: first };
}

/**
 * Does `candidate` carry a verbatim run of `input`? Such a name describes this one request
 * rather than a durable work cluster, so every similar request would mint another workbench.
 */
export function echoedWorkbenchSpan(candidate: string, input: string, span = WORKBENCH_ECHO_SPAN): string | null {
  const compactCandidate = compactWorkbenchText(candidate);
  const compactInput = compactWorkbenchText(input).slice(0, ECHO_SCAN_LIMIT);
  if (compactCandidate.length === 0 || compactInput.length === 0) return null;
  // A short stem lifted whole out of the input — the truncate-and-append case.
  if (compactCandidate.length >= WORKBENCH_ECHO_STEM && compactInput.includes(compactCandidate)) return compactCandidate;
  if (compactCandidate.length < span || compactInput.length < span) return null;
  for (let index = 0; index + span <= compactInput.length; index += 1) {
    const window = compactInput.slice(index, index + span);
    if (compactCandidate.includes(window)) return window;
  }
  return null;
}

/**
 * Abstract work clusters offered when nothing existing fits. Deliberately constant: a template
 * cannot restate the input, and a cluster that suits one trip also suits the next.
 */
const WORKBENCH_TEMPLATES: readonly Omit<WorkbenchSuggestion, "description" | "kind">[] = [
  {
    name: "调研与分析工坊",
    personaSummary: "先建立可验证的事实，再做推断；结论必须能追溯到来源，猜测不当结论。",
    projectLabel: "调研与分析",
    scopeSummary: "跨来源的资料收集、事实核对、对比分析与结论沉淀。",
  },
  {
    name: "工程开发与调试工坊",
    personaSummary: "围绕代码、构建与运行证据推进，改动要可复现、可验证。",
    projectLabel: "工程开发与调试",
    scopeSummary: "代码阅读与修改、构建与运行、故障排查与回归验证。",
  },
  {
    name: "行程与出行规划工坊",
    personaSummary: "先确认时间、地点与约束，再比较方案；不把未经核实的信息当既定事实。",
    projectLabel: "行程与出行规划",
    scopeSummary: "目的地资料整理、路线与时间安排、票务与口碑信息的比较。",
  },
  {
    name: "内容整理与写作工坊",
    personaSummary: "把散乱材料整理成结构清晰、可直接使用的成稿，保留出处。",
    projectLabel: "内容整理与写作",
    scopeSummary: "素材汇总、提纲设计、长文撰写与排版定稿。",
  },
];

function templateSuggestion(template: Omit<WorkbenchSuggestion, "description" | "kind">): WorkbenchSuggestion {
  return {
    ...template,
    description: `新建「${template.name}」，同类工作以后都会归到这里。`,
    kind: "template",
  };
}

/** Prepares one automatic creation suggestion; creation still requires an explicit user choice. */
export function workbenchCreationSuggestions(input: {
  seed: string;
  proposal?: Pick<WorkbenchSuggestion, "name" | "projectLabel" | "scopeSummary">;
}): WorkbenchSuggestion[] {
  if (input.proposal !== undefined) return [templateSuggestion({
    ...input.proposal, personaSummary: "围绕已确认的工程目标和工作范围推进，以可验证的证据记录结论。",
  })];
  const score = (template: Omit<WorkbenchSuggestion, "description" | "kind">) => workbenchMatchScore(input.seed, { ...template, workbenchId: "template" });
  const best = WORKBENCH_TEMPLATES.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best);
  return [templateSuggestion(best)];
}

/**
 * Candidates for the hand-pick list: existing workbenches that already carry this kind of work
 * first — reuse is almost always what the user wants — then abstract clusters to fill the list.
 */
export function workbenchSuggestions(input: {
  limit?: number;
  seed: string;
  workbenches: readonly WorkbenchMatchSource[];
}): WorkbenchSuggestion[] {
  const limit = input.limit ?? WORKBENCH_SUGGESTION_LIMIT;
  const existing: WorkbenchSuggestion[] = rankWorkbenchMatches(input.seed, input.workbenches)
    .filter((match) => match.score >= WORKBENCH_MATCH_CANDIDATE_SCORE && !echoedWorkbenchSpan(match.workbench.name, input.seed))
    .slice(0, Math.max(0, limit - 1))
    .map((match) => ({
      description: "复用这个已有工作台，这条输入会接着它的上下文走。",
      kind: "existing" as const,
      name: match.workbench.name,
      personaSummary: `沿用「${match.workbench.name}」已有的职责与范围。`,
      projectLabel: match.workbench.name,
      scopeSummary: match.workbench.scopeSummary,
      workbenchId: match.workbench.workbenchId,
    }));
  const suggestions = [...existing];
  for (const template of WORKBENCH_TEMPLATES) {
    if (suggestions.length >= limit) break;
    suggestions.push(templateSuggestion(template));
  }
  return suggestions.slice(0, limit);
}
