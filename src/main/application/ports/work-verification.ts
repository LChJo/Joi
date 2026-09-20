import type { WorkbenchExecutionContextReader } from "./workbench-context.js";
import type { WorkAcceptanceCheck } from "./work-orchestration.js";

export interface WorkVerificationInput {
  acceptanceChecks: WorkAcceptanceCheck[];
  artifacts: { name: string; size: number }[];
  body?: string;
  contextSnapshotId: string;
}

export interface WorkVerificationResult {
  /** Human-readable, path-relative explanation of a FAILED status. Never contains absolute paths. */
  detail?: string;
  reasonCode?: string;
  status: "FAILED" | "NOT_REQUIRED" | "PASSED";
}

export interface WorkVerifier {
  verify(input: WorkVerificationInput): Promise<WorkVerificationResult>;
}

export type WorkVerificationContextReader = Pick<WorkbenchExecutionContextReader, "loadForExecution">;
