import type { PartnerRevision } from "../../domain/partners/partner.js";

export type PartnerRunStatus = "COMPLETED" | "FAILED" | "WAITING_INPUT" | "WAITING_AUTH" | "UNKNOWN";

export interface PartnerRunRequest {
  actionId: string;
  avatarId: string;
  taskProjection: string;
  workId: string;
}

export interface PartnerRunResult {
  actionId: string;
  externalRunId: string;
  status: PartnerRunStatus;
  workId: string;
}

export interface PartnerExecutor {
  run(request: PartnerRunRequest, revision: PartnerRevision): Promise<PartnerRunResult>;
}

export interface PartnerAdapterRunner {
  run(request: PartnerRunRequest, revision: PartnerRevision): Promise<{ externalRunId: string; status: PartnerRunStatus }>;
}
