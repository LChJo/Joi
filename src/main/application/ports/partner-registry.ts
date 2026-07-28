import type { PartnerRevision } from "../../domain/partners/partner.js";

export type AppendPartnerRevisionInput = Omit<PartnerRevision, "registryRevision">;

export interface PartnerRegistryRepository {
  append(input: AppendPartnerRevisionInput): Promise<PartnerRevision>;
  getActive(partnerId: string): Promise<PartnerRevision | null>;
  getRevision(partnerRevisionId: string): Promise<PartnerRevision | null>;
  listActive(): Promise<PartnerRevision[]>;
}
