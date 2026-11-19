const sections = {
  preferences: "Long-term preferences",
  orchestration: "Reusable orchestration lessons",
  user_inputs: "User input summary",
  conclusions: "Project conclusions",
  verified_methods: "Effective methods",
  verification: "Verification practices",
  limitations: "Lessons and applicability",
  evolution: "Active learned methods",
  sources: "Recent evidence sources",
} as const;

const policy = {
  joi: { threshold: 5000, sections: ["preferences", "orchestration"] },
  workbench: { threshold: 20_000, sections: ["user_inputs", "conclusions", "verified_methods", "evolution", "sources"] },
  partner: { threshold: 1000, sections: ["verified_methods", "verification", "limitations"] },
} as const;

export type HistoricalScope = keyof typeof policy;
export interface HistoricalEntry {
  section: keyof typeof sections;
  text: string;
  source?: string;
  key?: string;
  compacted?: true;
}

export function historicalCompactionThreshold(scope: HistoricalScope): number { return policy[scope].threshold; }
export function historicalCharacters(text: string): number { return Array.from(text).length; }

export function renderHistoricalContext(scope: HistoricalScope, candidates: readonly HistoricalEntry[]): { text: string; entries: HistoricalEntry[] } {
  const selected = new Map<HistoricalEntry["section"], string[]>();
  const entries: HistoricalEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!(policy[scope].sections as readonly string[]).includes(candidate.section)) continue;
    const text = candidate.text.replace(/\s+/gu, " ").trim();
    if (text === "" || /\b(?:bearer\s+\S+|(?:api[_ -]?key|cookie|csrf|password|secret|token)\s*[:=])/iu.test(text)) continue;
    if (scope !== "workbench" && /(?:[A-Za-z]:[\\/]|(?:^|\s)\/(?:home|Users|mnt|tmp|var|opt)\/|https?:\/\/|\b[\w.-]+@[\w.-]+\.[A-Za-z]{2,}\b)/u.test(text)) continue;
    if (candidate.section === "sources" && !/^[\w:.-]{1,180}$/u.test(candidate.source ?? "")) continue;
    const line = `- ${text}${candidate.section === "sources" ? ` [${String(candidate.source)}]` : ""}`;
    const key = `${candidate.section}\n${candidate.key ?? line}`;
    if (seen.has(key)) continue;
    const existing = selected.get(candidate.section);
    seen.add(key);
    if (existing === undefined) selected.set(candidate.section, [line]); else existing.push(line);
    entries.push({ ...candidate, text });
  }
  const text = policy[scope].sections.flatMap(section => {
    const lines = selected.get(section);
    return lines === undefined ? [] : [`## ${sections[section]}\n${lines.join("\n")}`];
  }).join("\n\n");
  return { text, entries };
}
