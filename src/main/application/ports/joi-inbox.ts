export type JoiInboxStatus = "PENDING" | "CLARIFICATION_REQUIRED" | "ROUTED" | "CONSUMED";

export interface JoiInboxRecord {
  attachmentIds?: string[];
  avatarId?: string;
  body: string;
  createdAt: string;
  idempotencyKey: string;
  inputId: string;
  status: JoiInboxStatus;
  updatedAt: string;
}

export interface JoiInboxRepository {
  create(record: JoiInboxRecord): Promise<JoiInboxRecord>;
  list(): Promise<JoiInboxRecord[]>;
}
