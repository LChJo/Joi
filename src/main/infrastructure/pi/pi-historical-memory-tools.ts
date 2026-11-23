import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { HistoricalMemoryReader } from "../../application/ports/historical-memory.js";
import { renderHistoricalContext } from "../../domain/work/historical-context.js";

export const WORKBENCH_HISTORY_TOOL = "workbench_read_history";
const RECENT_SOURCE_LIMIT = 20;
const EVIDENCE_PAGE_LIMIT = 4_000;
const TURN_EVIDENCE_LIMIT = 32_768;

export function historicalMemoryTools(memory: HistoricalMemoryReader, workbenchId: string, includeSummary: boolean): AgentTool[] {
  let summaryRead = false;
  let evidenceLeft = TURN_EVIDENCE_LIMIT;
  const parameters = Type.Object({
    source: Type.Optional(Type.String({ maxLength: 180, description: "Use a source from the recent evidence list. Omit to list sources." })),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Start at 0, then use the previous page's nextOffset." })),
    part: Type.Optional(Type.Union([Type.Literal("input"),Type.Literal("conclusion")])),
  });
  const tool: AgentTool<typeof parameters> = {
    name: WORKBENCH_HISTORY_TOOL,
    label: "Read Workbench history",
    description: "List recent evidence for the current Workbench when source is omitted. Use a listed source and part=conclusion for the saved result. Follow nextOffset until it is null."
      + (includeSummary ? " The first list also includes the historical summary." : ""),
    parameters,
    executionMode: "sequential",
    execute: (_id,args) => {
      let value: unknown;
      if (args.source === undefined) {
        const history = renderHistoricalContext("workbench",memory.entries("workbench",workbenchId));
        const sources = history.entries.filter(entry => entry.section === "sources").slice(0,RECENT_SOURCE_LIMIT)
          .map(({ source,text }) => ({ source,description: text }));
        value = { sources,...(includeSummary && !summaryRead ? { summary: history.text } : {}) };
        summaryRead = true;
      } else if (evidenceLeft === 0) {
        value = { code: "workbench_history_evidence_budget_exhausted" };
      } else {
        const offset = args.offset ?? 0;
        const page = memory.readEvidence(workbenchId,args.source,offset,Math.min(EVIDENCE_PAGE_LIMIT,evidenceLeft),args.part);
        if (page === null) value = { code: "workbench_history_source_unavailable" };
        else {
          const size = Array.from(page.text).length;
          evidenceLeft -= size;
          value = { text: page.text,nextOffset: offset + size < page.total && size > 0 ? offset + size : null };
        }
      }
      return Promise.resolve({ content: [{ type: "text",text: JSON.stringify(value) }],details: {} });
    },
  };
  return [tool];
}
