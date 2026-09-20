import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type {
  WorkVerificationContextReader,
  WorkVerificationInput,
  WorkVerificationResult,
  WorkVerifier,
} from "../../application/ports/work-verification.js";

function failed(reasonCode: string, detail?: string): WorkVerificationResult {
  return { ...(detail === undefined ? {} : { detail }), reasonCode, status: "FAILED" };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export class WorkspaceWorkVerifier implements WorkVerifier {
  constructor(private readonly dependencies: { contexts: WorkVerificationContextReader }) {}

  async verify(input: WorkVerificationInput): Promise<WorkVerificationResult> {
    if (input.acceptanceChecks.length === 0) return { status: "NOT_REQUIRED" };
    const context = await this.dependencies.contexts.loadForExecution(input.contextSnapshotId);
    if (context === null) return failed("verification_context_missing");
    let canonicalRoot: string | undefined;
    for (const check of input.acceptanceChecks) {
      if (check.kind === "BODY_PRESENT") {
        if (input.body?.trim() === undefined || input.body.trim() === "") return failed("verification_body_missing");
        continue;
      }
      if (check.kind === "ARTIFACT_PRESENT") {
        if (!input.artifacts.some((artifact) => artifact.name === check.name)) return failed("verification_artifact_missing");
        continue;
      }
      if (context.workspacePath === undefined) return failed("verification_workspace_missing");
      // Detail names only the check and its workspace-relative path: absolute roots must
      // never leave this port, but the partner/user still needs to know what was expected.
      const where = `${check.kind} ${check.relativePath}`;
      const missing = `${where} was not found under this Work's execution root; acceptance checks cannot reference files outside it.`;
      try {
        canonicalRoot ??= await realpath(context.workspacePath);
        const candidate = path.resolve(canonicalRoot, check.relativePath);
        if (!inside(canonicalRoot, candidate)) return failed("verification_path_invalid", `${where} must stay inside this Work's execution root.`);
        let canonicalCandidate: string;
        try {
          canonicalCandidate = await realpath(candidate);
        } catch {
          return failed("verification_file_missing", missing);
        }
        if (!inside(canonicalRoot, canonicalCandidate)) return failed("verification_path_invalid", `${where} must stay inside this Work's execution root.`);
        const facts = await stat(canonicalCandidate);
        if (!facts.isFile()) return failed("verification_file_missing", missing);
        if (check.kind === "FILE_CONTAINS_EXACT") {
          const content = await readFile(canonicalCandidate, "utf8");
          if (!content.includes(check.expectedText)) return failed("verification_content_mismatch", `${where} does not contain the expected text.`);
        }
      } catch {
        return failed("verification_read_failed", `${where} could not be read.`);
      }
    }
    return { status: "PASSED" };
  }
}
