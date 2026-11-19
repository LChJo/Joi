import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

/** The closure binds one private transcript; callers cannot select another session or Work. */
export function createContextHistoryTool(messages: () => readonly unknown[] | Promise<readonly unknown[]>,
  readTurn?: (turnId: string) => Promise<readonly unknown[] | null>): AgentTool {
  let generation = 0;
  let snapshot: { cursor: string; turnId: string | undefined; chunks: string[]; ends: number[]; totalChars: number } | undefined;
  const open = async (turnId: string | undefined): Promise<typeof snapshot> => {
    const source = turnId === undefined ? await messages() : await readTurn?.(turnId);
    if (source === null || source === undefined) return undefined;
    const chunks = ["[", ...source.map((message, index) => `${index === 0 ? "" : ","}${JSON.stringify(message) || "null"}`), "]"];
    let totalChars = 0;
    const ends = chunks.map(chunk => { totalChars += chunk.length; return totalChars; });
    generation += 1;
    return { cursor: String(generation), turnId, chunks, ends, totalChars };
  };
  return {
    name: "context_read_history",
    label: "Read retained context history",
    description: "Read this task's retained private history in stable serialized character pages. Earlier messages may be omitted from the current request or represented by a checkpoint. Start at offset 0 without cursor; reuse the returned cursor and nextOffset until null. A new read from offset 0 opens a fresh view. Never infer that omitted history does not exist."
      + (readTurn === undefined ? "" : " The default history lists prior_turn records. Start a fresh read with one listed turnId to read that earlier execution."),
    parameters: Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
      cursor: Type.Optional(Type.String({ maxLength: 40 })),
      ...(readTurn === undefined ? {} : { turnId: Type.Optional(Type.String({ minLength: 1,maxLength: 200 })) }),
    }),
    ...(readTurn === undefined ? {} : { executionMode: "sequential" as const }),
    execute: async (_id, raw) => {
      const args = raw as { offset?: number; limit?: number; cursor?: string; turnId?: string };
      const offset = Number.isSafeInteger(args.offset) && (args.offset ?? 0) >= 0 ? args.offset ?? 0 : 0;
      const limit = Number.isSafeInteger(args.limit) ? Math.min(8000, Math.max(1, args.limit ?? 8000)) : 8000;
      if (args.cursor !== undefined && (args.cursor !== snapshot?.cursor
        || args.turnId !== undefined && args.turnId !== snapshot.turnId)) {
        return { content: [{ type: "text", text: JSON.stringify({ reasonCode: "context_history_cursor_expired", restartOffset: 0 }) }], details: {}, isError: true };
      }
      if (args.cursor === undefined && (snapshot === undefined || offset === 0 || args.turnId !== snapshot.turnId)) {
        snapshot = await open(args.turnId);
      }
      if (snapshot === undefined) {
        return { content: [{ type: "text",text: JSON.stringify({ reasonCode: "context_history_turn_unavailable" }) }],details: {},isError: true };
      }
      const end = Math.min(snapshot.totalChars, offset + limit);
      let low = 0;
      let high = snapshot.ends.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if ((snapshot.ends[middle] ?? 0) <= offset) low = middle + 1;
        else high = middle;
      }
      let body = "";
      for (let index = low; index < snapshot.chunks.length; index += 1) {
        const start = index === 0 ? 0 : snapshot.ends[index - 1] ?? 0;
        if (start >= end) break;
        body += (snapshot.chunks[index] ?? "").slice(Math.max(0, offset - start), end - start);
      }
      const page = { cursor: snapshot.cursor, offset, totalChars: snapshot.totalChars, nextOffset: end < snapshot.totalChars ? end : null, body };
      return { content: [{ type: "text", text: JSON.stringify(page) }], details: {} };
    },
  };
}
