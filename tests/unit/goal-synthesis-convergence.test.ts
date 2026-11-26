import { hasRepeatedSynthesisGaps, type GoalSynthesisState } from "../../src/main/domain/work/goal-synthesis-state.js";

const previousGap = { description: "Independent second review missing", requirementIds: ["report"], resultIds: [] };
const currentGap = { description: "Another offline check has not run", requirementIds: ["report"], resultIds: [] };
const previous: GoalSynthesisState = {
  version: 1, source: "MODEL", resultRevision: 1, requirementsRevision: 1,
  claims: [{ statement: "Report checked", requirementIds: ["report"], resultIds: ["r1"], verification: "VERIFIED" }],
  unresolved: [previousGap],
  conflicts: [],
};
const current: GoalSynthesisState = {
  ...previous, resultRevision: 2,
  unresolved: [currentGap],
};

it("recognizes a repeated requirement-scoped gap despite paraphrasing", () => {
  expect(hasRepeatedSynthesisGaps(previous, current, () => true)).toBe(true);
});

it("recognizes copied legacy state without assuming completion", () => {
  expect(hasRepeatedSynthesisGaps(previous, { ...previous, source: "LEGACY", resultRevision: 2 }, () => true)).toBe(true);
});

it("permits a new requirement or new relevant verified evidence", () => {
  expect(hasRepeatedSynthesisGaps(previous, { ...current, unresolved: [{ ...currentGap, requirementIds: ["other"] }] }, () => true)).toBe(false);
  expect(hasRepeatedSynthesisGaps(previous, { ...current, claims: [
    ...previous.claims, { statement: "Additional check", requirementIds: ["report"], resultIds: ["r2"], verification: "VERIFIED" },
  ] }, () => true)).toBe(false);
});

it("does not conflate differently described unscoped gaps", () => {
  expect(hasRepeatedSynthesisGaps({ ...previous, unresolved: [{ ...previousGap, requirementIds: [] }] },
    { ...current, unresolved: [{ ...currentGap, requirementIds: [] }] }, () => true)).toBe(false);
});
