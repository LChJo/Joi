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
