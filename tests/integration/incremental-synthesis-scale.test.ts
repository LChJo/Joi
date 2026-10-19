import { composeJoiContinuationBackground } from "../../src/main/application/joi/joi-continuation-prompt.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";

describe("fixed synthesis delta under growing historical evidence", () => {
  it.each([10, 100, 1000])("keeps three changed handoffs bounded with %i historical results", async history => {
    const handoff = { version: 1 as const, conclusion: "SEMANTIC_MIDDLE_FINDING", requirementIds: [], evidenceResultIds: [], artifactRefs: [],
      unresolved: ["Preserve the remaining gap"], conflicts: ["Source disagreement remains visible"] };
    const fixture = await createGoalEvidenceFixture(Array.from({ length: history + 3 }, () => ({ handoff })));
    try {
      const now = fixture.clock.now().toISOString();
      fixture.database.transaction(db => {
        db.prepare(`INSERT INTO joi_goal_outcomes(input_id,result_revision,disposition,completion_summary,completed_at,updated_at,requirements_revision)
          VALUES ('goal',?,'CONTINUE','Existing conclusion with a remaining conflict',?,?,0)`).run(history, now, now);
      });
      const input = await fixture.inbox.loadInput(fixture.inputId);
      expect(input?.synthesisContext?.changedResults.map(result => result.resultId)).toEqual([1, 2, 3].map(offset => `result-${String(history + offset)}`));
      expect(input?.synthesisContext?.totalChanges).toBe(3);
      for (const budget of [24_000, 40_000, 60_000] as const) {
        if (input === null) throw new Error("The synthetic input must exist.");
        const background = composeJoiContinuationBackground(input, budget);
        expect(background?.length).toBeLessThan(7000);
        expect(background).toContain("SEMANTIC_MIDDLE_FINDING");
        expect(background).toContain("Source disagreement remains visible");
        expect(background).not.toContain("PRIVATE_MIDDLE_");
        expect(background).not.toContain('"resultId":"result-1"');
      }
    } finally { await fixture.close(); }
  }, 60_000);
});
