import type { SseEvent } from "./runtime-store.js";
import type { WorkResult } from "../../domain/work/work-result.js";
import type { UserQuestionPrompt } from "../../../shared/user-questions.js";

export interface RecordedWorkResult {
  /** Downstream Works canceled in the same transaction because this result failed them. */
  cascadedWorkIds?: string[];
  event: SseEvent;
  isAuthoritative: boolean;
  result: WorkResult;
}

export interface WorkVerificationProjection {
  reasonCode?: string;
  status: "FAILED" | "NOT_REQUIRED" | "PASSED";
}

export interface WorkResultRepository {
  readBody(input: { workbenchId: string; limit: number; offset: number; resultId: string }): Promise<{ body: string; total: number } | null>;
  readVerification(resultId: string): Promise<WorkVerificationProjection | null>;
  /** The pause question commits atomically with an authoritative WAITING_INPUT result. */
  record(result: WorkResult, question?: UserQuestionPrompt): Promise<RecordedWorkResult>;
}
