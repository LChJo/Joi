import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Tool } from "@earendil-works/pi-ai";

/** Refreshes one outgoing policy and tool projection without rewriting the private transcript. */
export function withRequestPrompt(messages: readonly AgentMessage[],systemPrompt: string,tools?: readonly Tool[]): AgentMessage[] {
  const leading = messages[0];
  if (leading?.role !== "system") return [...messages];
  return messages.map((message,index) => {
    if (message.role !== "system") return message;
    const projection = { ...message,content: index === 0 ? systemPrompt : "" };
    delete projection.sections;
    if (tools !== undefined) {
      delete projection.toolsRemoved;
      if (index === 0) projection.toolsAdded = tools.map(({ name,description,parameters }) => ({ name,description,parameters }));
      else delete projection.toolsAdded;
    }
    return projection;
  });
}
