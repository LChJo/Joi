import type { AvatarSummary } from "./avatar-context.js";
import type { SourceFailureKind } from "../../domain/model-sources/model-source.js";

export interface JoiPendingInput {
  attachments?: { attachmentId: string; filename: string; mimeType: string; size: number }[];
  avatarId?: string;
  body: string;
  inputId: string;
  status: "CLARIFICATION_REQUIRED" | "CONSUMED" | "PENDING" | "ROUTED";
}

export interface JoiCoordinatorStore {
  completeInput(inputId: string, turnId: string): Promise<void>;
  createTurn(input: {
    avatarId: string;
    createdAt: string;
    inputId: string;
    modelRevisionId: string;
    sessionId: string;
    sourceRevisionId: string;
    turnId: string;
  }): Promise<void>;
  failTurn?(inputId: string, turnId: string): Promise<void>;
  loadInput(inputId: string): Promise<JoiPendingInput | null>;
  recordTurnProgress?(turnId: string, progress: { formalOutputStarted: boolean; sideEffectStarted: boolean }): Promise<void>;
  requireClarification(inputId: string, reasonCode: string): Promise<void>;
  updateTurnSource?(turnId: string, sourceRevisionId: string, modelRevisionId: string): Promise<void>;
}

export interface ReasoningFailureClassifier {
  classify(error: unknown): SourceFailureKind | null;
}

export interface AvatarRoutingRuntime {
  decide(input: { avatars: AvatarSummary[]; input: string; repair: boolean }): Promise<unknown>;
}
