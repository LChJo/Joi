import type { HarnessReviewDigest } from "../ports/joi-harness.js";

const DECISION_LINE_LIMIT = 8;
const FOG_LINE_LIMIT = 6;
const OPEN_PATH_LINE_LIMIT = 6;
const COMPLETION_SUMMARY_LIMIT = 320;

/**
 * Deterministic body for a harness review input. The digest is already bounded by
 * the scan; the limits here are the final gate so a stale or hand-built digest can
 * never inflate the turn prompt.
 */
export function composeReviewBody(digest: HarnessReviewDigest): string {
  const lines: string[] = [
    "Harness review: one layer of this goal's way is complete; chart the next.",
    `goalInputId=${digest.goalInputId}`,
    `resultRevision=${String(digest.resultRevision)}`,
  ];
  lines.push(digest.destination === null
    ? "destination=（尚未命名：先调用 harness_name_destination 命名这次努力的最终目标）"
    : `destination=${digest.destination}`);
  if (digest.decisions.length > 0) {
    lines.push("Decisions so far:");
    const listed = digest.decisions.slice(0, DECISION_LINE_LIMIT);
    for (const decision of listed) {
      lines.push(`- [${decision.kind}] ${decision.summary}`);
    }
    if (digest.decisionCount > listed.length) {
      lines.push(`- （另有 ${String(digest.decisionCount - listed.length)} 条更早的决策）`);
    }
  }
  if (digest.fogNotes.length > 0) {
    lines.push("Not yet specified (fog):");
    for (const note of digest.fogNotes.slice(0, FOG_LINE_LIMIT)) {
      lines.push(`- ${note}`);
    }
  }
  if (digest.openPaths.length > 0) {
    lines.push("Open paths:");
    for (const openPath of digest.openPaths.slice(0, OPEN_PATH_LINE_LIMIT)) {
      lines.push(`- L${String(openPath.layer)} ${openPath.title}`);
    }
  }
  lines.push(`Latest completion: ${digest.completionSummary.slice(0, COMPLETION_SUMMARY_LIMIT)}`);
  lines.push(
    "Discipline: resolve at most ONE decision with harness_record_decision; dispatch the next evidence layer with work_dispatch (its Work facts are mirrored into paths automatically, so do not chart the same Work again); use harness_chart_path only for a non-Work path; send new fog to harness_note_fog and graduate now-specifiable fog; if the destination is reached and no way remains, call turn_complete with MAP_CLEARED.",
  );
  return lines.join("\n");
}
