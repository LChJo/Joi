export type JoiInboxStatus = "CLARIFICATION_REQUIRED" | "CONSUMED" | "PENDING" | "ROUTED";

export interface JoiInboxRecord {
  attachmentIds?: string[];
  avatarId?: string;
  body: string;
  canceledAt?: string;
  clarificationReasonCode?: string;
  createdAt: string;
  idempotencyKey: string;
  inputId: string;
  status: JoiInboxStatus;
  updatedAt: string;
}

export interface JoiInboxRepository {
  cancel(inputId: string): Promise<JoiInboxRecord | null>;
  clarify(inputId: string, patch: { avatarId?: string; text?: string }): Promise<JoiInboxRecord | null>;
  create(record: JoiInboxRecord): Promise<JoiInboxRecord>;
  list(): Promise<JoiInboxRecord[]>;
}
