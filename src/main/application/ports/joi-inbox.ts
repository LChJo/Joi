export type JoiInboxStatus = "PENDING" | "CLARIFICATION_REQUIRED" | "ROUTED" | "CONSUMED";

export interface JoiInboxRecord {
  attachmentIds?: string[];
  avatarId?: string;
  body: string;
  clarificationReasonCode?: string;
  createdAt: string;
  idempotencyKey: string;
  inputId: string;
  status: JoiInboxStatus;
  updatedAt: string;
}

export interface JoiInboxRepository {
  clarify(inputId: string, patch: { avatarId?: string; text?: string }): Promise<JoiInboxRecord | null>;
  create(record: JoiInboxRecord): Promise<JoiInboxRecord>;
  list(): Promise<JoiInboxRecord[]>;
}
