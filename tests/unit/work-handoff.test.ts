import { parseWorkHandoff } from "../../src/main/domain/work/work-handoff.js";
import { createWorkResult } from "../../src/main/domain/work/work-result.js";

const handoff = {
  version: 1,
  conclusion: "The middle of the report establishes the conclusion.",
  requirementIds: ["req-1"],
  evidenceResultIds: ["evidence-1"],
  artifactRefs: ["artifact:report"],
  unresolved: ["The second requirement still needs evidence."],
  conflicts: ["Source B contradicts source A."],
} as const;

describe("private semantic Work handoff", () => {
  it("preserves the semantic conclusion independently from the bounded display preview", () => {
    const source = { ...handoff, requirementIds: [...handoff.requirementIds], evidenceResultIds: [...handoff.evidenceResultIds],
      artifactRefs: [...handoff.artifactRefs], unresolved: [...handoff.unresolved], conflicts: [...handoff.conflicts] };
    const body = `${"Opening material. ".repeat(50)} MIDDLE_CONCLUSION complete report`;
    const result = createWorkResult({ actionId: "action", artifacts: [], workbenchId: "wb", body,
      createdAt: "2026-10-19T00:00:00Z", isLate: false, partnerRevisionId: "partner-rev", resultId: "result", runId: "run",
      status: "COMPLETED", workId: "work", handoff: source, verification: { status: "FAILED", reasonCode: "missing_evidence" } });
    source.unresolved.pop();
    expect(result.body).toBe(body);
    expect(result.summary.length).toBeLessThanOrEqual(320);
    expect(result.summary).not.toContain("MIDDLE_CONCLUSION");
    expect(result.handoffStatus).toBe("PROVIDED");
    expect(result.handoff).toEqual(handoff);
    expect(result.verification.status).toBe("FAILED");
  });

  it("distinguishes missing handoff from malformed or truncated handoff without discarding the body", () => {
    expect(parseWorkHandoff(undefined)).toEqual({ status: "MISSING" });
    expect(parseWorkHandoff({ ...handoff, conclusion: "x".repeat(6001) })).toEqual({ status: "INVALID" });
    expect(parseWorkHandoff({ ...handoff, verification: "PASSED" })).toEqual({ status: "INVALID" });
    expect(parseWorkHandoff({ ...handoff, unresolved: "none" })).toEqual({ status: "INVALID" });
    expect(parseWorkHandoff(handoff)).toEqual({ status: "PROVIDED", handoff });
  });
});
