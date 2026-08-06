export interface WorkbenchPartnerKey {
  partnerId: string;
}

export interface WorkbenchPendingConfirmation {
  kind: "workbench_change" | "clarification" | "partner_waiting";
  reasonCode?: string;
  referenceId: string;
}

/** Authoritative terminal result not yet folded into the goal result set. */
export interface WorkbenchUnsynthesizedResult {
  workbenchId: string;
  eventId: string;
  partnerId: string;
  resultId: string;
  sessionDataSource: string;
  status: string;
  summary: string;
  title: string;
  workId: string;
}

/** DB-fact view the workbench agent component traverses each tick. */
export interface WorkbenchAgentScan {
  listPartnerKeys(workbenchId: string): Promise<WorkbenchPartnerKey[]>;
  listPendingConfirmations(workbenchId: string): Promise<WorkbenchPendingConfirmation[]>;
  listUnsynthesizedResults(workbenchId: string): Promise<WorkbenchUnsynthesizedResult[]>;
}
