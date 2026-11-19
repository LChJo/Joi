import { composeJoiContinuationBackground } from "../../src/main/application/joi/joi-continuation-prompt.js";

it("starts with stable evidence references at every continuation budget", () => {
  const answers = ([24_000,40_000,60_000] as const).map(budget => composeJoiContinuationBackground({
    body: "Synthesize",inputId: "synth",status: "PENDING",synthesisContext: {
      originalRequest: "MANDATORY SOURCES".repeat(5000),resultRevision: 164,requirementsRevision: 3,
      previous: { disposition: "CONTINUE",stateRef: "r163:q3:current" },
      changesRead: { resultRevision: 164,requirementsRevision: 3,afterResultRevision: 163 },
      totalChanges: 1,totalResults: 164,gapCount: 1,
    },
  },budget));
  expect(new Set(answers).size).toBe(1);
  expect(answers[0]?.length).toBeLessThan(2_000);
  expect(answers[0]).not.toContain("MANDATORY SOURCES");
  expect(answers[0]).toContain("work_read_evidence(mode=roadmap)");
  expect(answers[0]).toContain("r163:q3:current");
});
