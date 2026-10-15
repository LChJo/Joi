import { needsWorkbenchChoice, parseWorkbenchProposal, readWorkbenchProposal } from "../../src/shared/workbench-choice.js";

const draft = { name: "joi 工程工坊", projectLabel: "joi", scopeSummary: "工程维护。" };

it("projects only public proposal fields and tolerates absent or malformed optional data", () => {
  expect(readWorkbenchProposal({ ...draft, personaSummary: "PRIVATE", body: "PRIVATE" })).toEqual(draft);
  expect(parseWorkbenchProposal(JSON.stringify(draft))).toEqual(draft);
  for (const value of [undefined, null, 1, [], "text", {}, { ...draft, name: "" }, { ...draft, name: "a".repeat(81) },
    { ...draft, projectLabel: "" }, { ...draft, projectLabel: "a".repeat(121) },
    { ...draft, scopeSummary: "" }, { ...draft, scopeSummary: "a".repeat(1001) }]) {
    expect(readWorkbenchProposal(value)).toBeUndefined();
  }
  for (const value of [undefined, 1, "{broken", JSON.stringify(null)]) expect(parseWorkbenchProposal(value)).toBeUndefined();
});

it("recognizes the three compatible workbench choice reasons", () => {
  for (const reason of ["workbench_selection_invalid", "workbench_creation_unavailable", "workbench_not_found"]) expect(needsWorkbenchChoice(reason)).toBe(true);
  for (const reason of [undefined, "question_required", "workbench_workspace_not_ready"]) expect(needsWorkbenchChoice(reason)).toBe(false);
});
