import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Installs the current system prompt into one request without touching the transcript.
 *
 * Both of joi's pi runtimes recompute their prompt per turn — the Workbench evidence, knowledge and
 * Skills are reassembled each time — and used to assign `agent.state.systemPrompt`. pi 0.83 and
 * later keep that prompt inside the transcript as a leading system message and expose the field
 * read-only, so the assignment no longer exists.
 *
 * The documented alternative is to append another system message, but pi *concatenates* the content
 * of later system messages: a per-turn append would grow the prompt without bound. Rewriting the
 * leading message for the length of one request has neither problem — the request carries the
 * prompt that is current, and the transcript keeps the one it actually opened with, which is also
 * the more honest record.
 *
 * `prepareRequest` is the hook for this: it runs before every provider request, including the
 * first, and its result replaces the request's context without being written back to agent state.
 */
export function withRequestPrompt(messages: readonly AgentMessage[], systemPrompt: string): AgentMessage[] {
  const leading = messages[0];
  if (leading === undefined || roleOf(leading) !== "system") return [...messages];
  return [{ ...leading, content: systemPrompt } as AgentMessage, ...messages.slice(1)];
}

/** The earlier versions of this pipeline read roles without committing to the transcript's union. */
function roleOf(message: AgentMessage): string | undefined {
  return (message as { role?: string }).role;
}
