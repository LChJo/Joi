import { selectGoalEvidence } from "../../src/main/domain/work/goal-evidence.js";

describe("AC-43/48 goal evidence packages", () => {
  const rows = Array.from({ length: 163 }, (_, n) => ({ resultId: `r${String(n)}`, workId: `w${String(n)}`, title: `Work ${String(n)}`, body: `${String(n)}:` + "e".repeat(1500) + `TAIL${String(n)}`, status: "COMPLETED", verificationStatus: "PASSED", isLate: false, isAuthoritative: true }));
  const rowAt = (index: number) => { const row = rows[index]; if (row === undefined) throw new Error("Missing fixture row"); return row; };
  it("prioritizes explicit and dependency evidence, deduplicates, and preserves conclusion tails", () => {
    const selected = selectGoalEvidence({ results: rows, explicitResultIds: ["r81", "r81"], dependencyWorkIds: ["w25"], budget: 24_000 });
    expect(selected.results.slice(0, 2).map(r => r.resultId)).toEqual(["r81", "r25"]);
    expect(new Set(selected.results.map(r => r.resultId)).size).toBe(selected.results.length);
    expect(selected.inline.length).toBeLessThanOrEqual(24_000);
    expect(selected.inline).toContain("TAIL81");
    expect(selected.inline).toContain("omitted");
    expect(selected.totalResults).toBe(163);
  });
  it("does not upgrade explicitly selected failed or late results into verified evidence", () => {
    const selected = selectGoalEvidence({ results: [{ ...rowAt(0), status: "FAILED", isLate: true, verificationStatus: "FAILED" }, ...rows.slice(1)], explicitResultIds: ["r0"] });
    expect(selected.results[0]).toMatchObject({ status: "FAILED", isLate: true, verificationStatus: "FAILED" });
  });
  it("keeps unverified historical results retrievable without selecting them as accepted recent evidence", () => {
    const selected = selectGoalEvidence({ results: [{ ...rowAt(0),verificationStatus: "UNVERIFIED" }] });
    expect(selected.results).toHaveLength(0);
    expect(selected.totalResults).toBe(1);
  });
  it("bounds serialized escaping and retains every explicit identity behind a large first citation", () => {
    const selected = selectGoalEvidence({ results: rows.map(row => ({ ...row,body: '\n"\\'.repeat(20_000) + `TAIL-${row.resultId}` })),explicitResultIds: ["r81","r82","r83","r84","r85"],budget: 24_000 });
    expect(selected.inline.length).toBeLessThanOrEqual(24_000);
    for (const id of ["r81","r82","r83","r84","r85"]) expect(selected.inline).toContain(id);
    expect(selected.inline).toContain("TAIL-r81");
  });
  it("counts a conservative exception when required reference metadata exceeds 60K", () => {
    const many = rows.map(row => ({ ...row,title: "title".repeat(120) }));
    const selected = selectGoalEvidence({ results: many,explicitResultIds: many.map(row => row.resultId) });
    expect(selected.budgetFallbackCount).toBe(1);
    expect(selected.budgetCharacters).toBeGreaterThan(60_000);
    expect(selected.results).toHaveLength(163);
    expect(selected.inline.length).toBeLessThanOrEqual(selected.budgetCharacters);
  });
  it("keeps the tail of an oversized explicitly referenced result and offers stable rereading", () => {
    const selected = selectGoalEvidence({ results: [{ ...rowAt(81), body: "x".repeat(70_000) + "CONCLUSION_END" }], explicitResultIds: ["r81"] });
    expect(selected.inline.length).toBeLessThanOrEqual(60_000);
    expect(selected.inline).toContain("CONCLUSION_END");
    expect(selected.inline).toContain("work_read_result");
    expect(selected.results[0]?.body).toContain("omitted");
  });
});
