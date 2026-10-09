export type JoiInboxStatus = "CLARIFICATION_REQUIRED" | "CONSUMED" | "PENDING" | "ROUTED";

export interface JoiInboxRecord {
  attachmentIds?: string[];
  archivedAt?: string;
  automationRoutineId?: string;
  workbenchId?: string;
  body: string;
  canceledAt?: string;
  clarificationPrompt?: string;
  clarificationReasonCode?: string;
  createdAt: string;
  dismissedAt?: string;
  failedAt?: string;
  failureCount?: number;
  failureExecutionStarted?: boolean;
  failureReasonCode?: string;
  idempotencyKey: string;
  inputId: string;
  questionId?: string;
  questionVersion?: number;
  status: JoiInboxStatus;
  updatedAt: string;
}

export interface JoiInboxRepository {
  /** Files a finished goal out of the home feed. Reversible, unlike {@link dismiss}. */
  archive(inputId: string): Promise<JoiInboxRecord | null>;
  cancel(inputId: string): Promise<JoiInboxRecord | null>;
  /** Compatibility closure for a historical review after deterministic facts prove completion. */
  closeHistoricalReview?(inputId: string): Promise<JoiInboxRecord | null>;
  /** Stops queued goals without touching partner runs already in flight. */
  cancelQueued?(): Promise<number>;
  clarify(inputId: string, patch: { actionChoice?: "RESUME" | "CONTINUE" | "ACCEPT_CURRENT"; expectedQuestionId?: string; expectedQuestionVersion?: number; expectedReasonCode?: string; workbenchId?: string; text?: string }): Promise<JoiInboxRecord | null>;
  create(record: JoiInboxRecord): Promise<JoiInboxRecord>;
  dismiss(inputId: string): Promise<JoiInboxRecord | null>;
  list(): Promise<JoiInboxRecord[]>;
  park(inputId: string, failure: { failureCount: number; reasonCode: string }): Promise<JoiInboxRecord | null>;
  retry(inputId: string, patch: { text?: string }): Promise<JoiInboxRecord | null>;
  unarchive(inputId: string): Promise<JoiInboxRecord | null>;
}
