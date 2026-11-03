export interface UserAttachmentRecord {
  attachmentId: string;
  createdAt: string;
  eventId?: string;
  filename: string;
  lifeId: string;
  mimeType: string;
  relativePath: string;
  sha256: string;
  size: number;
}

export interface UserAttachmentStore {
  createUserAttachment(record: UserAttachmentRecord): Promise<UserAttachmentRecord>;
  getUserAttachment(attachmentId: string): Promise<UserAttachmentRecord | null>;
  listLifeUserAttachments(lifeId: string): Promise<UserAttachmentRecord[]>;
}
