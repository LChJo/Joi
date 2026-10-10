import type { WorkbenchSummary } from "./workbench-context.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";

/** Private persisted evidence for one goal; never a display or diagnostics projection. */
export interface JoiGoalContext {
  originalRequest: string;
  destination?: string;
  completion?: { summary: string; disposition: string };
  decisions: { kind: string; summary: string; detail: string }[];
  fogNotes: string[];
  totalResults?: number;
  results: {
    artifactCount: number;
    artifacts: unknown[];
    body: string;
    resultId: string;
    title: string;
    workId: string;
  }[];
}

export interface JoiPendingInput {
  automationRoutineId?: string;
  attachments?: { attachmentId: string; filename: string; mimeType: string; size: number }[];
  workbenchId?: string;
  body: string;
  continuationPrompt?: string;
  goalContext?: JoiGoalContext;
  goalInputId?: string;
  inputId: string;
  resultRevision?: number;
  resolvedAction?: { actionId: string; decision: "RESUME"; workId: string };
  status: "CLARIFICATION_REQUIRED" | "CONSUMED" | "PENDING" | "ROUTED";
}

export type JoiCompletionOutcome = "DIRECT_ANSWER" | "TEAM_READY" | "RESULT_SYNTHESIZED" | "RESULT_CONTINUE" | "RESULT_BLOCKED";

export interface JoiInputCompletion {
  completionSummary: string;
  outcome: JoiCompletionOutcome;
  /** The model explicitly committed this outcome with turn_complete. */
  committedByTool?: boolean;
}

export interface JoiCoordinatorStore {
  completeResolvedAction?(input: { actionId: string; inputId: string; turnId: string }): Promise<void>;
  completeInput(inputId: string, turnId: string, completion?: JoiInputCompletion): Promise<unknown>;
  createTurn(input: {
    workbenchId: string;
    createdAt: string;
    inputId: string;
    modelRevisionId?: string;
    sessionId: string;
    sourceRevisionId?: string;
    turnId: string;
  }): Promise<void>;
  failTurn?(inputId: string, turnId: string): Promise<void>;
  loadInput(inputId: string): Promise<JoiPendingInput | null>;
  recordTurnProgress?(turnId: string, progress: { formalOutputStarted: boolean; sideEffectStarted: boolean }): Promise<void>;
  requireClarification(inputId: string, reasonCode: string, prompt?: string, action?: {
    actionId: string;
    kind: "PARTNER_QUESTION";
    runId: string;
    workId: string;
  }): Promise<void>;
  resumeGoal?(input: { inputId: string; turnId: string }): Promise<{ status: "OPEN" }>;
  updateTurnSource?(turnId: string, sourceRevisionId: string, modelRevisionId: string): Promise<void>;
}

export interface ReasoningFailureClassifier {
  classify(error: unknown): SourceFailureKind | null;
}

export interface WorkbenchRoutingRuntime {
  /**
   * `route` picks among the listed workbenches and may create one; `abstract` is asked only after
   * routing failed, and must name a durable cluster rather than pick or restate the request.
   */
  decide(input: {
    workbenches: WorkbenchSummary[];
    input: string;
    mode?: "abstract" | "route";
    repair: boolean;
  }): Promise<unknown>;
}
