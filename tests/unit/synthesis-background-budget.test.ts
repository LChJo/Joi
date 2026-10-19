import { composeJoiContinuationBackground } from "../../src/main/application/joi/joi-continuation-prompt.js";

it("keeps a large previous conclusion's ending and retrieval identity inside every synthesis budget", () => {
  for (const maxChars of [24_000, 40_000, 60_000] as const) {
    const background = composeJoiContinuationBackground({ body: "Synthesize", inputId: "synth", status: "PENDING", synthesisContext: {
      originalRequest: "necessary requirement ".repeat(5000), resultRevision: 164, requirementsRevision: 3,
      previous: { resultRevision: 163, disposition: "CONTINUE", summary: `CONCLUSION_START ${'"\\\n'.repeat(10_000)} CONCLUSION_END` },
      changedResults: [], totalResults: 163, gapCount: 1, omittedChanges: 0,
    } }, maxChars);
    expect(background?.length).toBeLessThanOrEqual(maxChars);
    expect(background).toContain("CONCLUSION_START");
    expect(background).toContain("CONCLUSION_END");
    expect(background).toContain("work_read_evidence");
    expect(background).toContain('"resultRevision":163');
  }
});

it("budgets semantic state and delta guidance while retaining a complete retrieval path for omitted first-page results", () => {
  for (const maxChars of [24_000, 40_000, 60_000] as const) {
    const background = composeJoiContinuationBackground({ body: "Synthesize", inputId: "synth", status: "PENDING", synthesisContext: {
      originalRequest: "Mandatory", resultRevision: 103, requirementsRevision: 3,
      previous: { resultRevision: 100, requirementsRevision: 3, disposition: "CONTINUE", summary: "PRESERVE_ENDING ".repeat(600), stateRef: "r100:q3",
        state: { version: 1, source: "MODEL", resultRevision: 100, requirementsRevision: 3,
          claims: Array.from({ length: 30 }, () => ({ statement: "x".repeat(1500), requirementIds: [], resultIds: ["old"], verification: "UNVERIFIED" as const })),
          unresolved: [{ description: "OLD_UNRESOLVED", requirementIds: [], resultIds: ["old"] }], conflicts: [] } },
      changesRead: { resultRevision: 103, requirementsRevision: 3, afterResultRevision: 100 }, nextChangesCursor: "after-16",
      changedResults: Array.from({ length: 16 }, (_, index) => ({ resultId: `r-${String(index)}`, workId: "w", status: "COMPLETED", verification: "PASSED", isLate: false,
        isAuthoritative: true, summary: "display", handoff: { version: 1 as const, conclusion: "c".repeat(3200), requirementIds: [], evidenceResultIds: [], artifactRefs: [], unresolved: [], conflicts: [] } })),
      totalResults: 103, totalChanges: 19, gapCount: 1, omittedChanges: 3,
    } }, maxChars);
    expect(background?.length).toBeLessThanOrEqual(maxChars);
    const data = JSON.parse(background?.split("\n\n")[1] ?? "{}") as { initialChangesOmitted: boolean; nextChangesCursor?: string; previous: { stateOmitted: boolean; stateRef: string } };
    expect(data.initialChangesOmitted).toBe(true);
    expect(data.nextChangesCursor).toBeUndefined();
    expect(data.previous).toMatchObject({ stateOmitted: true, stateRef: "r100:q3" });
    expect(background).toContain("start WITHOUT a cursor");
  }
});
