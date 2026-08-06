import type { WorkbenchExecutionContextReader } from "./workbench-context.js";
import type { WorkAcceptanceCheck } from "./work-orchestration.js";

export interface WorkVerificationInput {
  acceptanceChecks: WorkAcceptanceCheck[];
  artifacts: { name: string; size: number }[];
  contextSnapshotId: string;
}

export interface WorkVerificationResult {
  reasonCode?: string;
  status: "FAILED" | "NOT_REQUIRED" | "PASSED";
}

export interface WorkVerifier {
  verify(input: WorkVerificationInput): Promise<WorkVerificationResult>;
}

export type WorkVerificationContextReader = Pick<WorkbenchExecutionContextReader, "loadForExecution">;
