import type { WorkbenchSummary } from "./workbench-context.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";

export interface JoiPendingInput {
  attachments?: { attachmentId: string; filename: string; mimeType: string; size: number }[];
  workbenchId?: string;
  body: string;
  goalInputId?: string;
  inputId: string;
  resultRevision?: number;
  resolvedAction?: { actionId: string; decision: "RESUME"; workId: string };
  status: "CLARIFICATION_REQUIRED" | "CONSUMED" | "PENDING" | "ROUTED";
}

export type JoiCompletionOutcome = "DIRECT_ANSWER" | "TEAM_READY" | "RESULT_SYNTHESIZED" | "RESULT_BLOCKED";

export interface JoiInputCompletion {
  completionSummary: string;
  outcome: JoiCompletionOutcome;
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
  updateTurnSource?(turnId: string, sourceRevisionId: string, modelRevisionId: string): Promise<void>;
}

export interface ReasoningFailureClassifier {
  classify(error: unknown): SourceFailureKind | null;
}

export interface WorkbenchRoutingRuntime {
  decide(input: { workbenches: WorkbenchSummary[]; input: string; repair: boolean }): Promise<unknown>;
}
