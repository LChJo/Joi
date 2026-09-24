import { describe, expect, it } from "vitest";
import { EvolutionDryRun } from "../../src/main/application/evolution/evolution-dry-run.js";

// A frozen clock keeps the whole batch inside one accounting day, so the step count is a property of
// the pipeline rather than of when the test ran.
const dryRun = () => new EvolutionDryRun({ now: () => "2026-09-24T00:00:00.000Z", id: () => "dry-run" });
const withoutDuration = (report: Awaited<ReturnType<EvolutionDryRun["run"]>>) => { const { durationMs, ...rest } = report; void durationMs; return rest; };

describe("evolution dry run", () => {
  it("drives a full batch to promotion on a deterministic stand-in", async () => {
    const report = await dryRun().run("a");
    expect(report.outcome).toBe("promoted");
    expect(report.verdict).toBe("promoted");
    expect(report.truncated).toBe(false);
    expect(report.blockedAt).toBeNull();
    // 30 development + 1 proposal + 30 candidate + 180 sealed, three calls each: the same budget the
    // panel quotes, locked here so an added scenario cannot silently change what a batch costs.
    expect(report.steps).toBe(721);
    expect(report.phases).toEqual([
      { phase: "DEVELOP", steps: 90, rollouts: 30 },
      { phase: "PROPOSE", steps: 1, rollouts: 0 },
      { phase: "VALIDATE", steps: 90, rollouts: 30 },
      { phase: "EVALUATE", steps: 540, rollouts: 180 },
    ]);
    expect(report.evaluation).toEqual({ scenarios: 30, baselineSuccesses: 85, candidateSuccesses: 90, evaluatedRuns: 180 });
    expect(report.revision).toMatchObject({ module: "completion", status: "ACTIVE", reason: "promoted" });
    expect(report.selfCheck).toEqual({ expectedVerdict: "promote", matched: true });
    expect(report.syntheticEvidence).toEqual({ evaluable: 10, verificationFailed: 3 });
  });
  it("repeats exactly, so a verdict can be compared between runs", async () => {
    expect(withoutDuration(await dryRun().run("a"))).toEqual(withoutDuration(await dryRun().run("a")));
  });
  it("reports truncation instead of failing when the step budget runs out", async () => {
    const report = await new EvolutionDryRun({ now: () => "2026-09-24T00:00:00.000Z", id: () => "dry-run", maxSteps: 1 }).run("a");
    expect(report.outcome).toBe("truncated");
    expect(report.truncated).toBe(true);
    expect(report.steps).toBe(1);
    expect(report.blockedAt).toEqual({ phase: "DEVELOP", reason: "evaluating" });
    expect(report.promoted).toBe(false);
  });
  it("distinguishes a batch that never started from one that was rejected", async () => {
    const report = await new EvolutionDryRun({ now: () => "2026-09-24T00:00:00.000Z", id: () => "dry-run", maxSteps: 0 }).run("a");
    expect(report.outcome).toBe("not_started");
    expect(report.verdict).toBeNull();
    expect(report.revision).toBeNull();
  });
  it("keeps scenario content and goal ids out of the report", async () => {
    const serialized = JSON.stringify(await dryRun().run("a"));
    expect(serialized).not.toContain("record-");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("read_evidence");
  });
});
