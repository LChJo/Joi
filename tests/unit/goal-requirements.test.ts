import { assertCurrentRequirements, mergeGoalRequirements, renderGoalRequirements, type GoalRequirement, type GoalRequirements, type RequirementsUpdate } from "../../src/main/domain/work/goal-requirements.js";

const rule: GoalRequirement = { id: "day", kind: "CONSTRAINT", scope: "GLOBAL", mandatory: true, text: "Only the current day", source: { sourceRevision: 1, start: 0, end: 20 } };
const contract: GoalRequirements = { goalInputId: "goal", workbenchId: "wb", revision: 1, sourceRevision: 2, processedSourceRevision: 1, status: "DIRTY", requirements: [rule] };
const correction = { sourceRevision: 2, start: 0, end: 20 };
function update(patch: Partial<RequirementsUpdate> = {}): RequirementsUpdate { return { goalInputId: "goal", workbenchId: "wb", expectedRevision: 1, processedSourceRevision: 2, upserts: [], retirements: [], ...patch }; }

describe("effective requirement merge invariants", () => {
  it("requires a fully processed current version at execution boundaries", () => {
    const ready: GoalRequirements = { ...contract, status: "READY", processedSourceRevision: 2 };
    expect(() => assertCurrentRequirements(ready, 1)).not.toThrow();
    expect(() => assertCurrentRequirements(contract, 1)).toThrow(expect.objectContaining({ code: "goal_requirements_pending" }));
    expect(() => assertCurrentRequirements({ ...ready, processedSourceRevision: 1 }, 1)).toThrow(expect.objectContaining({ code: "goal_requirements_pending" }));
    expect(() => assertCurrentRequirements(ready, 0)).toThrow(expect.objectContaining({ code: "goal_requirements_stale" }));
    expect(() => assertCurrentRequirements(ready)).toThrow(expect.objectContaining({ code: "goal_requirements_stale" }));
  });
  it("keeps unmentioned requirements, permits an exact no-op, and requires an explicit fresh correction", () => {
    expect(mergeGoalRequirements(contract, update())).toEqual([rule]);
    expect(mergeGoalRequirements(contract, update({ upserts: [rule] }))).toEqual([rule]);
    expect(mergeGoalRequirements(contract, update({ upserts: [{ ...rule, source: correction }] }))).toEqual([rule]);
    expect(mergeGoalRequirements(contract, update({ upserts: [{ ...rule, id: "repeated", source: correction }] }))).toEqual([rule]);
    const replacement: GoalRequirement = { ...rule, text: "Only yesterday", source: correction, explicitUserCorrection: true };
    expect(mergeGoalRequirements(contract, update({ upserts: [replacement] }))).toEqual([replacement]);
    expect(() => mergeGoalRequirements(contract, update({ upserts: [{ ...replacement, explicitUserCorrection: undefined } as unknown as GoalRequirement] }))).toThrow(expect.objectContaining({ code: "goal_requirements_user_correction_required" }));
    expect(mergeGoalRequirements(contract, update({ retirements: [{ id: "day", source: correction, explicitUserCorrection: true }] }))).toEqual([]);
    const staging = { ...contract, processedSourceRevision: 0, sourceRevision: 1 };
    expect(mergeGoalRequirements(staging, update({ processedSourceRevision: 0, upserts: [{ ...replacement, source: { sourceRevision: 1, start: 30, end: 50 } }] }))[0]?.text).toBe("Only yesterday");
  });

  it.each([
    { expectedRevision: 0 }, { processedSourceRevision: 0 }, { processedSourceRevision: 3 }, { processedSourceRevision: 1.5 },
  ])("rejects stale or invalid processing checkpoints %j", patch => {
    expect(() => mergeGoalRequirements(contract, update(patch))).toThrow();
  });

  it("applies an explicit correction under its stable id when it matches another requirement", () => {
    const other: GoalRequirement = { ...rule, id: "other", text: "Only yesterday" };
    const replacement: GoalRequirement = { ...rule, text: other.text, source: correction, explicitUserCorrection: true };
    const merged = mergeGoalRequirements({ ...contract, requirements: [rule, other] }, update({ upserts: [replacement] }));
    expect(merged.find(item => item.id === rule.id)).toEqual(replacement);
    expect(merged.find(item => item.id === other.id)).toEqual(other);
    expect(merged.some(item => item.text === rule.text)).toBe(false);
    expect(renderGoalRequirements({ ...contract, requirements: merged }, [rule.id], false)).toContain(other.text);
  });

  it.each([
    { id: "" }, { id: "x".repeat(121) }, { text: " " }, { kind: "UNKNOWN" }, { scope: "UNKNOWN" }, { mandatory: "yes" },
  ])("rejects malformed requirements %j", patch => {
    expect(() => mergeGoalRequirements(contract, update({ upserts: [{ ...rule, id: "new", source: correction, ...patch } as unknown as GoalRequirement] }))).toThrow(expect.objectContaining({ code: "goal_requirements_invalid" }));
  });

  it("rejects duplicates, obsolete sources, implicit retirement and unknown retirement ids", () => {
    const added: GoalRequirement = { ...rule, id: "new", source: correction };
    expect(() => mergeGoalRequirements(contract, update({ upserts: [added, added] }))).toThrow();
    expect(() => mergeGoalRequirements(contract, update({ upserts: [{ ...rule, text: "Changed" }] }))).toThrow(expect.objectContaining({ code: "goal_requirements_source_invalid" }));
    expect(() => mergeGoalRequirements(contract, update({ upserts: [{ ...rule, id: "resurrected" }] }))).toThrow(expect.objectContaining({ code: "goal_requirements_source_invalid" }));
    expect(() => mergeGoalRequirements(contract, update({ retirements: [{ id: "day", source: correction }] }))).toThrow(expect.objectContaining({ code: "goal_requirements_user_correction_required" }));
    expect(() => mergeGoalRequirements(contract, update({ retirements: [{ id: "missing", source: correction, explicitUserCorrection: true }] }))).toThrow(expect.objectContaining({ code: "goal_requirements_invalid" }));
  });

  it("renders complete current requirements or the selected Work scope without authority expansion", () => {
    const local: GoalRequirement = { ...rule, id: "local", text: "Relevant task detail", scope: "SCOPED" };
    const optional: GoalRequirement = { ...rule, id: "preference", text: "Optional global preference", mandatory: false };
    const current: GoalRequirements = { ...contract, requirements: [rule, local, optional], nextUnreadSource: { sourceRevision: 2, offset: 4000, totalChars: 8000 } };
    expect(renderGoalRequirements(current)).toContain("Optional global preference");
    expect(renderGoalRequirements(current, [], false)).toContain(rule.text);
    expect(renderGoalRequirements(current, [], false)).not.toContain(local.text);
    expect(renderGoalRequirements(current, ["local"], false)).toContain(local.text);
    expect(renderGoalRequirements(current, undefined, false)).not.toContain(optional.text);
    expect(renderGoalRequirements(current)).toContain("nextUnreadSource=");
    expect(renderGoalRequirements({ ...current, status: "READY" })).not.toContain("Before dispatch");
    expect(() => renderGoalRequirements(current, ["unknown"], false)).toThrow(expect.objectContaining({ code: "goal_requirements_selection_invalid" }));
  });
});
