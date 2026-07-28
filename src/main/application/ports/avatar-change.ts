export type AvatarChangeKind = "ARCHIVE" | "MERGE";
export type AvatarChangeStatus = "PENDING" | "CONFIRMED" | "REJECTED";

export interface AvatarChangeRequest {
  createdAt: string;
  decidedAt?: string;
  kind: AvatarChangeKind;
  reason: string;
  requestId: string;
  sourceAvatarId: string;
  status: AvatarChangeStatus;
  targetAvatarId?: string;
  turnId: string;
}

export interface AvatarChangeRepository {
  create(request: AvatarChangeRequest): Promise<void>;
  decide(requestId: string, decision: "CONFIRM" | "REJECT", decidedAt: string): Promise<AvatarChangeRequest>;
  get(requestId: string): Promise<AvatarChangeRequest | null>;
  isActive(avatarId: string): Promise<boolean>;
  listPending(): Promise<AvatarChangeRequest[]>;
}
