import { renderGoalRequirements, type GoalRequirements } from "../../src/main/domain/work/goal-requirements.js";

it("preserves mandatory requirements and trusted source checkpoints when evidence context overflows", () => {
  const contract: GoalRequirements = {
    goalInputId: "goal",workbenchId: "bench",revision: 4,status: "DIRTY",sourceRevision: 5,processedSourceRevision: 4,
    nextUnreadSource: { sourceRevision: 5,offset: 120,totalChars: 5000 },
    requirements: [
      { id: "optional",kind: "PREFERENCE",mandatory: false,scope: "GLOBAL",text: "😀".repeat(8000),source: { sourceRevision: 1,start: 0,end: 1 } },
      { id: "scope",kind: "CONSTRAINT",mandatory: true,scope: "GLOBAL",text: "Preserve read-only scope",source: { sourceRevision: 1,start: 0,end: 1 } },
      { id: "report",kind: "DELIVERABLE",mandatory: true,scope: "SCOPED",text: "Deliver a report",source: { sourceRevision: 1,start: 0,end: 1 } },
    ],
  };
  const rendered = renderGoalRequirements(contract,undefined,true,8000);
  expect(Array.from(rendered).length).toBeLessThanOrEqual(8000);
  expect(rendered).toContain("Preserve read-only scope");
  expect(rendered).toContain("Deliver a report");
  expect(rendered).toContain("omittedRequirements=1");
  expect(rendered).toContain("keeping processedSourceRevision unchanged until that entire source is read");
});
