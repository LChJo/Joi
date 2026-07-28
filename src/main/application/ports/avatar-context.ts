import type { Avatar } from "../../domain/avatar/avatar.js";

export interface AvatarSummary {
  avatarId: string;
  name: string;
  scopeSummary: string;
  updatedAt: string;
}

export interface AvatarCatalog {
  getAvatar(avatarId: string): Promise<Avatar | null>;
  listSummaries(): Promise<AvatarSummary[]>;
}

export interface AvatarRepository extends AvatarCatalog {
  createAvatar(avatar: Avatar): Promise<void>;
}

export interface LegacyAvatarPolicyReader {
  getPreferredPartnerId(avatarId: string): Promise<string | null>;
}
