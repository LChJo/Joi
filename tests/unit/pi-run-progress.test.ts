import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRunProgressWatch, DEFAULT_RUN_PROGRESS_THRESHOLDS, stallNudgeMessage } from "../../src/main/infrastructure/pi/pi-run-progress.js";

/** Small thresholds so a test exercises the sequence rather than the constants. */
const fast = {
  probeEveryToolCalls: 1,
  probeMinIntervalMillis: 0,
  probesBeforeCloseOut: 3,
  probesBeforeNudge: 2,
  toolCallCeiling: 100,
} as const;

describe("run progress watch", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "joi-progress-"));
  });
  afterEach(() => {
    rmSync(workspace, { force: true, recursive: true });
  });

  it("warns before it ends anything, and only ends a run whose warning went unanswered", async () => {
    const watch = createRunProgressWatch({ canWrite: true, thresholds: fast, workspacePath: workspace });
    // The first probe establishes the baseline; it has nothing to compare against yet.
    expect(await watch.observeToolCall()).toEqual({ kind: "working" });
    expect(await watch.observeToolCall()).toEqual({ kind: "working" });
    expect(await watch.observeToolCall())
      .toEqual({ kind: "nudge", nudge: { toolCallsWithoutChange: 2 } });
    // A second warning would be noise; the run is ended instead, and only now.
    expect(await watch.observeToolCall())
      .toEqual({ kind: "close-out", reason: "no-deliverable", toolCallsWithoutChange: 3 });
  });

  it("treats a changed workspace as progress and starts counting again", async () => {
    const watch = createRunProgressWatch({ canWrite: true, thresholds: fast, workspacePath: workspace });
    await watch.observeToolCall();
    await watch.observeToolCall();
    writeFileSync(join(workspace, "deliverable.md"), "work");
    // The change resets the count, so the nudge that was one probe away does not arrive.
    expect(await watch.observeToolCall()).toEqual({ kind: "working" });
    expect(await watch.observeToolCall()).toEqual({ kind: "working" });
    expect((await watch.observeToolCall()).kind).toBe("nudge");
  });

  it("never watches a run that cannot change the workspace, or one without a workspace", async () => {
    // A read-only run produces nothing by design; calling that a stall would be wrong every time.
    const readOnly = createRunProgressWatch({ canWrite: false, thresholds: fast, workspacePath: workspace });
    for (let index = 0; index < 10; index += 1) expect(await readOnly.observeToolCall()).toEqual({ kind: "working" });

    const withoutWorkspace = createRunProgressWatch({ canWrite: true, thresholds: fast, workspacePath: undefined });
    for (let index = 0; index < 10; index += 1) expect(await withoutWorkspace.observeToolCall()).toEqual({ kind: "working" });
  });

  it("ends a run that reaches the tool-call ceiling even while it is still producing", async () => {
    // The outer backstop is a count, and a count cannot tell work from thrash — so it is a
    // deliberate exception to the rule that only a stalled run is ended.
    const watch = createRunProgressWatch({
      canWrite: true,
      thresholds: { ...fast, toolCallCeiling: 1 },
      workspacePath: workspace,
    });
    expect(await watch.observeToolCall())
      .toEqual({ kind: "close-out", reason: "tool-call-ceiling", toolCallsWithoutChange: 0 });
  });

  it("reports what it decided, so a stall is never only visible in its effect", async () => {
    const events: { type: string }[] = [];
    const watch = createRunProgressWatch({
      canWrite: true,
      onDiagnostic: (event) => events.push(event),
      thresholds: fast,
      workspacePath: workspace,
    });
    for (let index = 0; index < 6; index += 1) await watch.observeToolCall();
    // Once each: the run is closed out once, however many more events arrive afterwards.
    expect(events.map((event) => event.type)).toEqual(["joi.partner.progress_stalled", "joi.partner.run_closed_out"]);
  });

  it("defaults leave a producing run alone for a long time", () => {
    // The numbers that matter are the ones shipped, not the ones a test injects.
    expect(DEFAULT_RUN_PROGRESS_THRESHOLDS.probesBeforeNudge * DEFAULT_RUN_PROGRESS_THRESHOLDS.probeEveryToolCalls).toBe(150);
    expect(DEFAULT_RUN_PROGRESS_THRESHOLDS.probesBeforeCloseOut).toBeGreaterThan(DEFAULT_RUN_PROGRESS_THRESHOLDS.probesBeforeNudge);
    // The ceiling sits below the ten-hour run this was written for (7,972 tool calls) and well
    // above what a run doing real work needs, so reaching it means something the other checks did not.
    expect(DEFAULT_RUN_PROGRESS_THRESHOLDS.toolCallCeiling).toBeLessThan(7_972);
    expect(DEFAULT_RUN_PROGRESS_THRESHOLDS.toolCallCeiling).toBeGreaterThan(1_500);
  });

  it("names the observation and both readings of it, and forbids starting over", () => {
    const message = stallNudgeMessage({ toolCallsWithoutChange: 150 });
    expect(message).toContain("150");
    expect(message).toContain("still gathering context");
    expect(message).toContain("say so");
    expect(message).toContain("Do not start over");
  });
});
