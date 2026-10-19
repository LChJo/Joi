/* Pi tool callbacks use the asynchronous AgentTool contract. */
/* eslint-disable @typescript-eslint/require-await */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

/** The closure binds one private transcript; callers cannot select another session or Work. */
export function createContextHistoryTool(messages: () => readonly unknown[]): AgentTool {
  return {
    name: "context_read_history",
    label: "Read retained context history",
    description: "Read this task's retained private history in serialized character pages. Earlier messages may be omitted from the current request or represented by a checkpoint. Start at offset 0; follow nextOffset until null. Never infer that omitted history does not exist.",
    parameters: Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8000 })),
    }),
    execute: async (_id, raw) => {
      const args = raw as { offset?: number; limit?: number };
      const offset = Number.isSafeInteger(args.offset) && (args.offset ?? 0) >= 0 ? args.offset ?? 0 : 0;
      const limit = Number.isSafeInteger(args.limit) ? Math.min(8000, Math.max(1, args.limit ?? 8000)) : 8000;
      const body = JSON.stringify(messages());
      const end = Math.min(body.length, offset + limit);
      const page = { offset, totalChars: body.length, nextOffset: end < body.length ? end : null, body: body.slice(offset, end) };
      return { content: [{ type: "text", text: JSON.stringify(page) }], details: {} };
    },
  };
}
