import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { DomainError } from "../../domain/errors.js";
import type { WorkbenchExecutionContextReader } from "../../application/ports/workbench-context.js";

type Evidence = NonNullable<Awaited<ReturnType<WorkbenchExecutionContextReader["loadForExecution"]>>>["evidence"];

/** Private readers bind every identifier to this task's goal and Workbench. */
export function createPartnerEvidenceTools(evidence: Evidence): AgentTool[] {
  if (evidence === undefined) return [];
  const index = JSON.parse(evidence.index) as {
    results?: { resultId: string; file: string }[];
    conclusions?: { outcomeId: string; file: string }[];
  };
  const page = (body: string, cursor?: string) => {
    if (cursor !== undefined && !/^(?:0|[1-9]\d*)$/u.test(cursor)) throw new DomainError("work_result_cursor_invalid", "Evidence cursor is invalid.");
    const offset = Number(cursor ?? 0);
    if (!Number.isSafeInteger(offset)) throw new DomainError("work_result_cursor_invalid", "Evidence cursor is invalid.");
    const content = body.slice(offset, offset + 8000);
    return { content, totalCharacters: body.length, ...(offset + content.length < body.length ? { nextCursor: String(offset + content.length) } : {}) };
  };
  const body = (name: string | undefined): string => {
    const file = evidence.files.find(item => item.name === name);
    if (file === undefined) throw new DomainError("goal_evidence_not_found", "Evidence was not found in this task's goal.");
    return file.body;
  };
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
  return [{
    name: "work_read_evidence", label: "Read task evidence index",
    description: "Read this task's goal evidence index or a historical conclusion in 8000-character pages. Includes failed, late and unverified evidence with explicit identities. Omitted evidence is still retrievable. Follow nextCursor; use work_read_result for full result bodies.",
    parameters: Type.Object({ mode: Type.Optional(Type.Union([Type.Literal("index"), Type.Literal("conclusion")])), outcomeId: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) }),
    execute: async (_id, raw) => {
      const args = raw as { mode?: string; outcomeId?: string; cursor?: string };
      if (evidence.reader !== undefined) {
        const pageArgs = args.cursor === undefined ? {} : { cursor: args.cursor };
        if (args.mode !== "conclusion") return result(await evidence.reader.index(pageArgs));
        if (args.outcomeId === undefined) throw new DomainError("goal_evidence_not_found","Provide a conclusion identity from this goal's evidence index.");
        return result(await evidence.reader.readConclusion({ ...pageArgs,outcomeId: args.outcomeId }));
      }
      return result(page(args.mode === "conclusion" ? body(index.conclusions?.find(item => item.outcomeId === args.outcomeId)?.file) : evidence.index, args.cursor));
    },
  }, {
    name: "work_read_result", label: "Read task evidence result",
    description: "Read a result from this task's goal evidence index, including its acceptance/status identity, in 8000-character pages. Follow nextCursor through the conclusion tail. Failed, late and unverified evidence is not accepted success.",
    parameters: Type.Object({ resultId: Type.String(), cursor: Type.Optional(Type.String()) }),
    execute: async (_id, raw) => {
      const args = raw as { resultId: string; cursor?: string };
      if (evidence.reader !== undefined) return result(await evidence.reader.readResult(args));
      return result(page(body(index.results?.find(item => item.resultId === args.resultId)?.file), args.cursor));
    },
  }];
}
