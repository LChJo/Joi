import { abbreviateAbsolutePaths } from "../text/path-abbreviation.js";
import { truncateAtSentenceBoundary } from "../text/sentence-truncation.js";

export type WorkResultStatus = "COMPLETED" | "FAILED" | "WAITING_INPUT" | "WAITING_AUTH" | "UNKNOWN";

const SUMMARY_PREVIEW_LIMIT = 320;

export interface WorkResult {
  actionId: string;
  artifacts: { artifactRef?: string; mimeType?: string; name: string; size: number }[];
  workbenchId: string;
  body: string;
  createdAt: string;
  instanceId?: string;
  isLate: boolean;
  partnerRevisionId: string;
  resultId: string;
  runId: string;
  status: WorkResultStatus;
  summary: string;
  verification: { reasonCode?: string; status: "FAILED" | "NOT_REQUIRED" | "PASSED" };
  workId: string;
}

const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/][^\s]+|\\\\[^\\\s]+\\[^\s]+|(?:^|\s)\/(?:Users|home|var|tmp|opt|mnt)\/[^\s]+)/gu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const NAMED_SECRET = /\b(?:api[_-]?key|csrf|token)\s*[:=]\s*\S+/giu;

function sanitizeSummary(value: string): string {
  return abbreviateAbsolutePaths(value, ABSOLUTE_PATH)
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(NAMED_SECRET, "secret=[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
}

export function summarizeWorkResult(body: string, status: WorkResultStatus): string {
  const compact = sanitizeSummary(body);
  return truncateAtSentenceBoundary(compact === "" ? `Partner run ${status.toLowerCase()}.` : compact, SUMMARY_PREVIEW_LIMIT);
}

export function createWorkResult(input: Omit<WorkResult, "summary" | "verification"> & {
  summary?: string;
  verification?: WorkResult["verification"];
}): WorkResult {
  return {
    ...input,
    artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
    summary: truncateAtSentenceBoundary(
      input.summary === undefined ? summarizeWorkResult(input.body, input.status) : sanitizeSummary(input.summary),
      SUMMARY_PREVIEW_LIMIT,
    ),
    verification: input.verification ?? { status: "NOT_REQUIRED" },
  };
}
