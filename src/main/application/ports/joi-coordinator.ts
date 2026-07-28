import type { AvatarSummary } from "./avatar-context.js";

export interface JoiPendingInput {
  body: string;
  inputId: string;
  status: "PENDING" | "CLARIFICATION_REQUIRED" | "ROUTED" | "CONSUMED";
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
  requireClarification(inputId: string, reasonCode: string): Promise<void>;
}

export interface AvatarRoutingRuntime {
  decide(input: { avatars: AvatarSummary[]; input: string; repair: boolean }): Promise<unknown>;
}
