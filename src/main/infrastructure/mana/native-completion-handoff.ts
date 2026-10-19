import { parseWorkHandoff, WORK_HANDOFF_INSTRUCTION, WORK_HANDOFF_SCHEMA, type WorkHandoff, type WorkHandoffStatus } from "../../domain/work/work-handoff.js";

export const NATIVE_COMPLETION_TOOL_NAME = "StructuredOutput";

export const NATIVE_COMPLETION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["body", "handoff"],
  properties: { body: { type: "string", minLength: 1 }, handoff: WORK_HANDOFF_SCHEMA },
} as const;

export const NATIVE_COMPLETION_INSTRUCTION = `${WORK_HANDOFF_INSTRUCTION} Return one JSON object with body (the complete user deliverable) and handoff (the private semantic metadata). Keep the complete deliverable in body; handoff is not a substitute for it.`;

export interface NativeCompletion {
  body: string;
  handoff?: WorkHandoff;
  handoffStatus: WorkHandoffStatus;
}

function visibleFallback(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "handoff")) {
      const row = parsed as Record<string, unknown>;
      return typeof row.body === "string" ? row.body : "";
    }
  } catch {
    if (/^\s*\{/u.test(body) && /"handoff"\s*:/u.test(body)) return "";
  }
  return body;
}

/** Plaintext is an older completion contract; structured metadata remains private. */
export function parseNativeCompletion(value: unknown, fallbackBody: string): NativeCompletion {
  let candidate = value;
  let privateEnvelope: string | undefined;
  if (typeof candidate === "string") {
    const text = candidate;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "handoff")) {
        candidate = parsed;
        privateEnvelope = text;
      } else candidate = undefined;
    } catch {
      candidate = undefined;
      if (/^\s*\{/u.test(text) && /"handoff"\s*:/u.test(text)) privateEnvelope = text;
    }
  }
  const withoutEnvelope = privateEnvelope !== undefined && fallbackBody !== privateEnvelope && fallbackBody.endsWith(privateEnvelope)
    ? fallbackBody.slice(0, -privateEnvelope.length).trimEnd() : fallbackBody;
  const safeFallback = visibleFallback(withoutEnvelope);
  if (candidate === undefined) return { body: safeFallback, handoffStatus: privateEnvelope === undefined && safeFallback === fallbackBody ? "MISSING" : "INVALID" };
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return { body: safeFallback, handoffStatus: "INVALID" };
  const row = candidate as Record<string, unknown>;
  const rowBody = row.body;
  const hasBody = typeof rowBody === "string" && rowBody.trim() !== "";
  const body = hasBody ? rowBody : safeFallback;
  if (!hasBody || Object.keys(row).some((key) => key !== "body" && key !== "handoff")) {
    return { body, handoffStatus: "INVALID" };
  }
  const parsed = parseWorkHandoff(row.handoff);
  return parsed.status === "PROVIDED" ? { body, handoff: parsed.handoff, handoffStatus: parsed.status } : { body, handoffStatus: parsed.status };
}
