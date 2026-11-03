export type WorkbenchChangeKind = "ARCHIVE" | "MERGE";
export type WorkbenchChangeStatus = "PENDING" | "CONFIRMED" | "REJECTED";

export interface WorkbenchChangeRequest {
  createdAt: string;
  decidedAt?: string;
  kind: WorkbenchChangeKind;
  reason: string;
  requestId: string;
  sourceWorkbenchId: string;
  status: WorkbenchChangeStatus;
  targetWorkbenchId?: string;
  turnId: string;
}

export interface WorkbenchChangeRepository {
  archiveConfirmed(request: WorkbenchChangeRequest): Promise<WorkbenchChangeRequest>;
  create(request: WorkbenchChangeRequest): Promise<void>;
  decide(requestId: string, decision: "CONFIRM" | "REJECT", decidedAt: string): Promise<WorkbenchChangeRequest>;
  get(requestId: string): Promise<WorkbenchChangeRequest | null>;
  isActive(workbenchId: string): Promise<boolean>;
  listPending(): Promise<WorkbenchChangeRequest[]>;
}
