import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { HistoricalMemoryReader } from "../../application/ports/historical-memory.js";
import { renderHistoricalContext } from "../../domain/work/historical-context.js";

export const WORKBENCH_HISTORY_TOOL = "workbench_read_history";

export function historicalMemoryTools(memory: HistoricalMemoryReader, workbenchId: string, includeSummary: boolean): AgentTool[] {
  let summaryRead = false;
  let evidenceLeft = 12_000;
  const parameters = Type.Object({
    source: Type.Optional(Type.String({ maxLength: 180 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    part: Type.Optional(Type.Union([Type.Literal("input"),Type.Literal("conclusion")])),
  });
  const tool: AgentTool<typeof parameters> = {
    name: WORKBENCH_HISTORY_TOOL,
    label: "Read Workbench history",
    description: includeSummary
      ? "Read the current Workbench’s historical summary and recent evidence index once. Provide a source reference to read a bounded original evidence page."
      : "Read a bounded original evidence page using a source from the current Workbench’s recent evidence index.",
    parameters,
    executionMode: "sequential",
    execute: (_id,args) => {
      let value: unknown;
      if (args.source === undefined) {
        value = includeSummary && !summaryRead ? { summary: renderHistoricalContext("workbench",memory.entries("workbench",workbenchId)).text }
          : { code: "workbench_history_summary_already_available" };
        summaryRead = true;
      } else if (evidenceLeft === 0) {
        value = { code: "workbench_history_evidence_budget_exhausted" };
      } else {
        const offset = args.offset ?? 0;
        const page = memory.readEvidence(workbenchId,args.source,offset,Math.min(4000,evidenceLeft),args.part);
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
