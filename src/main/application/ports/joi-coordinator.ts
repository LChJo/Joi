import type { WorkbenchSummary } from "./workbench-context.js";
import type { WorkbenchProposalDto } from "../../../shared/joi.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";
import type { GoalSynthesisDraft, GoalSynthesisState } from "../../domain/work/goal-synthesis-state.js";
import type { GoalEvidenceChange, GoalEvidenceChangesQuery } from "./goal-evidence.js";

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
  /** Per-version private background; it never becomes a persisted user message. */
  synthesisContext?: {
    originalRequest: string;
    resultRevision: number;
    requirementsRevision: number;
    previous?: { resultRevision: number; requirementsRevision?: number; disposition: string; summary: string; state?: GoalSynthesisState; stateOmitted?: boolean; stateRef?: string };
    changedResults: ({ resultId: string; workId: string; status: string; verification: string; summary: string; isLate: boolean; isAuthoritative: boolean }
      & Partial<Pick<GoalEvidenceChange, "revision" | "handoff" | "handoffStatus" | "handoffCharacters" | "handoffOmitted" | "handoffRef" | "handoffReadHint">>)[];
    changesRead?: Omit<GoalEvidenceChangesQuery, "goalInputId" | "workbenchId" | "cursor">;
    nextChangesCursor?: string;
    totalChanges?: number;
    totalResults: number;
    gapCount: number;
    omittedChanges: number;
  };
  requirementsRevision?: number;
  automationRoutineId?: string;
  automationExecutionId?: string;
  automationExecutionPrompt?: string;
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
  synthesisState?: GoalSynthesisDraft;
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
    /** The requirements revision this turn starts from; a tool-less turn ends against it. */
    requirementsRevision?: number;
    sessionId: string;
    sourceRevisionId?: string;
    turnId: string;
  }): Promise<void>;
  failTurn?(inputId: string, turnId: string, failure?: {
    reasonCode: string;
    /** Settled review calls contain only lookups, internal map facts or proven pre-execution rejections. */
    reviewReplaySafe?: boolean;
  }): Promise<void>;
  loadInput(inputId: string): Promise<JoiPendingInput | null>;
  recordTurnProgress?(turnId: string, progress: { formalOutputStarted: boolean; sideEffectStarted: boolean }): Promise<void>;
  requireClarification(inputId: string, reasonCode: string, prompt?: string, action?: {
    actionId: string;
    kind: "PARTNER_QUESTION";
    runId: string;
    workId: string;
  }, proposal?: WorkbenchProposalDto): Promise<void>;
  resumeGoal?(input: { inputId: string; turnId: string; requirementsRevision?: number }): Promise<{ status: "OPEN" }>;
  updateTurnSource?(turnId: string, sourceRevisionId: string, modelRevisionId: string): Promise<void>;
}

export interface ReasoningFailureClassifier {
  classify(error: unknown): SourceFailureKind | null;
}

export interface WorkbenchRoutingRuntime {
  /**
   * `route` selects a clear unique scope match, asks for selection, or proposes a draft.
   * `abstract` only proposes a durable context; creating it requires user confirmation.
   */
  decide(input: {
    workbenches: WorkbenchSummary[];
    input: string;
    mode?: "abstract" | "route";
    repair: boolean;
  }): Promise<unknown>;
}
