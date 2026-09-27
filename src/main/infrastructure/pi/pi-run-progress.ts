import { captureWorkspaceSnapshot, type WorkspaceSnapshot } from "../workspace/workspace-output-artifacts.js";

/**
 * Notices a run that is still working but no longer producing anything.
 *
 * The failure this exists for: a partner run spent ten hours and 7,972 tool calls, wrote nothing
 * for the first six and a half of them, and delivered nothing. Nothing in the runtime could
 * see it. The idle deadline keeps getting refreshed because tool calls keep arriving, the dispatch
 * watchdog is renewed by the same progress, and the compaction added alongside this is about what
 * the model can *remember* rather than what it is *doing*. Every existing guard asks "is it still
 * moving", and it was.
 *
 * How the rest of the field answers this, and why this shape: no surveyed agent harness implements
 * a no-progress heuristic at all — Claude Code's loop-detection request was closed as not planned,
 * OpenAI's Codex has an open issue asking for exactly this after a 37-hour run that only ever wrote
 * planning documents, and OpenHands' stuck detector watches for repeated actions, which a run whose
 * every call differs sails past. What does exist is the counter: Google ADK caps a run at 500 model
 * calls by default, which would have stopped this one at a fifth of its length.
 *
 * So this uses both, in the order the evidence supports. The evidence check runs first and is the
 * one that matters: it asks whether the workspace has changed, which is the same question the run's
 * own deliverable is judged by. The counter is only the outer backstop, set far enough out that a
 * run doing real work never reaches it — a count cannot tell work from thrash, and a fuse that
 * cannot tell them apart should be the last resort rather than the first.
 *
 * It nudges before it ends anything. A run that has stopped producing may be stuck, or may simply
 * be reading a great deal before it writes; the two are indistinguishable from the outside, and a
 * message costs nothing while a killed run costs everything it had done. The model is told what was
 * observed and asked to either make progress or say what is blocking it — the same correction a
 * human reviewer would offer before taking the work away.
 */

/**
 * Where each limit sits, named so the one place that decides them is also the one place that
 * records why. They are overridable because a contract test cannot wait out a thirty-second probe
 * interval or make a hundred and fifty tool calls — the same reason the idle deadline and the tool
 * timeout are already injectable in this engine.
 */
export interface RunProgressThresholds {
  /** Workspace probes are taken on this cadence of tool calls. */
  probeEveryToolCalls: number;
  /** ...but never more often than this, so a fast run cannot spend its time walking the filesystem. */
  probeMinIntervalMillis: number;
  /** Probes with no workspace change before the model is told. */
  probesBeforeNudge: number;
  /** Probes with no change after that, the nudge having gone unanswered, before the run is ended. */
  probesBeforeCloseOut: number;
  /**
   * Outer backstop, in tool calls for the whole run. Google ADK's default of 500 model calls lands
   * near 1,500 tool calls at this pipeline's ratio, and the run this was written for made 7,972 —
   * this sits between them: high enough that a run doing real work is not interrupted for being
   * long, low enough to bound one that keeps producing without converging.
   */
  toolCallCeiling: number;
}

export const DEFAULT_RUN_PROGRESS_THRESHOLDS: RunProgressThresholds = {
  probeEveryToolCalls: 25,
  probeMinIntervalMillis: 30_000,
  // ≈150 tool calls of activity with nothing written, then ≈600 more after the model was warned.
  probesBeforeCloseOut: 24,
  probesBeforeNudge: 6,
  toolCallCeiling: 4_000,
} as const;

export interface RunProgressNudge {
  toolCallsWithoutChange: number;
}

export type RunProgressSignal =
  | { kind: "working" }
  | { kind: "nudge"; nudge: RunProgressNudge }
  | { kind: "close-out"; reason: "no-deliverable" | "tool-call-ceiling"; toolCallsWithoutChange: number };

export type RunProgressDiagnostic =
  | { toolCallsWithoutChange: number; type: "joi.partner.progress_stalled" }
  | { reason: "no-deliverable" | "tool-call-ceiling"; toolCallsWithoutChange: number; type: "joi.partner.run_closed_out" };

export interface RunProgressWatch {
  /** Records one started tool call. Resolves to what the run's owner should do about it. */
  observeToolCall: () => Promise<RunProgressSignal>;
}

/**
 * Whether anything in the workspace moved. Deliberately the same rule the deliverable uses, so a
 * run is never told it produced nothing while its own result lists artifacts, or the reverse.
 */
function workspaceChanged(before: WorkspaceSnapshot, after: WorkspaceSnapshot): boolean {
  if (before.size !== after.size) return true;
  for (const [path, state] of after) {
    const previous = before.get(path);
    if (previous === undefined) return true;
    if (previous.size !== state.size || previous.mtimeMs !== state.mtimeMs) return true;
  }
  return false;
}

export function createRunProgressWatch(input: {
  /** A run with no way to change the workspace cannot stall on producing nothing. */
  canWrite: boolean;
  workspacePath: string | undefined;
  onDiagnostic?: (event: RunProgressDiagnostic) => void;
  /** Injected so a test does not have to wait out the probe interval. */
  now?: () => number;
  thresholds?: RunProgressThresholds;
}): RunProgressWatch {
  const now = input.now ?? Date.now;
  const thresholds = input.thresholds ?? DEFAULT_RUN_PROGRESS_THRESHOLDS;
  // A read-only run produces nothing by design, and a run without a workspace has nothing to
  // produce into. Watching either would report a stall on the first probe of every such run.
  const watching = input.canWrite && input.workspacePath !== undefined;
  let toolCalls = 0;
  let lastProbeAt = now();
  let lastSnapshot: WorkspaceSnapshot | undefined;
  let unchangedProbes = 0;
  let nudged = false;
  let closedOut: { reason: "no-deliverable" | "tool-call-ceiling"; toolCallsWithoutChange: number } | undefined;

  const probe = async (): Promise<RunProgressSignal> => {
    const snapshot = await captureWorkspaceSnapshot(input.workspacePath);
    const previous = lastSnapshot;
    lastSnapshot = snapshot;
    lastProbeAt = now();
    // The first probe has nothing to compare against; it establishes the baseline instead.
    if (previous === undefined || workspaceChanged(previous, snapshot)) {
      unchangedProbes = 0;
      return { kind: "working" };
    }
    unchangedProbes += 1;
    const stalledFor = unchangedProbes * thresholds.probeEveryToolCalls;
    // The close-out only follows a nudge that went unanswered: a run that never got the chance to
    // correct itself has not been given the benefit the warning exists to give.
    if (unchangedProbes >= thresholds.probesBeforeCloseOut && nudged) {
      input.onDiagnostic?.({ reason: "no-deliverable", toolCallsWithoutChange: stalledFor, type: "joi.partner.run_closed_out" });
      closedOut = { reason: "no-deliverable", toolCallsWithoutChange: stalledFor };
      return { kind: "close-out", ...closedOut };
    }
    if (unchangedProbes >= thresholds.probesBeforeNudge && !nudged) {
      nudged = true;
      input.onDiagnostic?.({ toolCallsWithoutChange: stalledFor, type: "joi.partner.progress_stalled" });
      return { kind: "nudge", nudge: { toolCallsWithoutChange: stalledFor } };
    }
    return { kind: "working" };
  };

  return {
    observeToolCall: async () => {
      // The decision is made once. A closed-out run keeps returning the same answer rather than
      // re-deciding and re-reporting on every later event in a stream that is already winding down.
      if (closedOut !== undefined) return { kind: "close-out", ...closedOut };
      toolCalls += 1;
      if (!watching) return { kind: "working" };
      if (toolCalls >= thresholds.toolCallCeiling) {
        const stalledFor = unchangedProbes * thresholds.probeEveryToolCalls;
        input.onDiagnostic?.({ reason: "tool-call-ceiling", toolCallsWithoutChange: stalledFor, type: "joi.partner.run_closed_out" });
        closedOut = { reason: "tool-call-ceiling", toolCallsWithoutChange: stalledFor };
        return { kind: "close-out", ...closedOut };
      }
      if (toolCalls % thresholds.probeEveryToolCalls !== 0 || now() - lastProbeAt < thresholds.probeMinIntervalMillis) {
        return { kind: "working" };
      }
      return await probe();
    },
  };
}

/**
 * What the model is told when its run stops producing. It states what was observed, offers both
 * readings of it, and asks for one of two concrete answers — because a run that is merely reading
 * a lot can say so and carry on, and one that is stuck needs to hear that before it can say why.
 */
export function stallNudgeMessage(nudge: RunProgressNudge): string {
  return `[joi progress notice] ${String(nudge.toolCallsWithoutChange)} tool calls have run without changing anything `
    + "in the workspace. Either you are still gathering context, or you are stuck. Both are fine to say out loud: "
    + "if you are still working toward a change, continue and ignore this. If you are stuck — a tool is not doing "
    + "what you expect, the task is unclear, or an approach is not working — say so in one short paragraph: what you "
    + "have established so far, what is blocking you, and what you would try next. Do not start over from the "
    + "beginning and do not repeat work you have already completed.";
}
