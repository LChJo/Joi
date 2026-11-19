import type { HarnessReviewDigest } from "../ports/joi-harness.js";

export function composeReviewBody(digest: Pick<HarnessReviewDigest, "goalInputId" | "resultRevision" | "continuationRequested">): string {
  return [
    "Harness review: assess whether this goal is ready to close or needs another evidence layer.",
    `goalInputId=${digest.goalInputId} resultRevision=${String(digest.resultRevision)}`,
    "Start with work_read_evidence(mode=roadmap). Follow the current synthesis state and inspect only gaps, changed results or conflicting evidence. Read full result bodies with work_read_result when needed.",
    digest.continuationRequested === true
      ? "The result synthesis explicitly found the evidence incomplete. Do not call MAP_CLEARED. Arrange the next safe evidence layer or explain what prevents it."
      : "Call turn_complete with MAP_CLEARED only after the current synthesis and evidence support the goal and there are no active or open paths.",
    "Resolve at most ONE decision. Work dispatches already appear as paths. Use harness_chart_path for non-Work paths; use harness_note_fog for newly discovered gaps.",
  ].join("\n");
}
