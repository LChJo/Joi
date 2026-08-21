export type JoiInboxStatus = "CLARIFICATION_REQUIRED" | "CONSUMED" | "PENDING" | "ROUTED";

export interface JoiInboxRecord {
  attachmentIds?: string[];
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
  status: JoiInboxStatus;
  updatedAt: string;
}

export interface JoiInboxRepository {
  cancel(inputId: string): Promise<JoiInboxRecord | null>;
  clarify(inputId: string, patch: { workbenchId?: string; text?: string }): Promise<JoiInboxRecord | null>;
  create(record: JoiInboxRecord): Promise<JoiInboxRecord>;
  dismiss(inputId: string): Promise<JoiInboxRecord | null>;
  list(): Promise<JoiInboxRecord[]>;
  park(inputId: string, failure: { failureCount: number; reasonCode: string }): Promise<JoiInboxRecord | null>;
  retry(inputId: string, patch: { text?: string }): Promise<JoiInboxRecord | null>;
}
