import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/* In-memory context ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */

import { WorkspaceWorkVerifier } from "../../src/main/infrastructure/workspace/workspace-work-verifier.js";

describe("workspace Work verifier", () => {
  it("checks exact file content inside the controlled Workbench workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-work-verifier-"));
    try {
      await writeFile(path.join(root, "hello.txt"), "hellow", "utf8");
      const verifier = new WorkspaceWorkVerifier({
        contexts: { loadForExecution: async () => ({ promptSection: "safe", sanitized: {}, workspacePath: root }) },
      });
      await expect(verifier.verify({
        acceptanceChecks: [{ expectedText: "hellow", kind: "FILE_CONTAINS_EXACT", relativePath: "hello.txt" }],
        artifacts: [], contextSnapshotId: "context_1",
      })).resolves.toEqual({ status: "PASSED" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects traversal and reports only a stable reason code", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-work-verifier-boundary-"));
    try {
      await mkdir(path.join(root, "inside"));
      const verifier = new WorkspaceWorkVerifier({
        contexts: { loadForExecution: async () => ({ promptSection: "safe", sanitized: {}, workspacePath: root }) },
      });
      const result = await verifier.verify({
        acceptanceChecks: [{ kind: "FILE_EXISTS", relativePath: "../secret.txt" }],
        artifacts: [], contextSnapshotId: "context_1",
      });
      expect(result).toEqual({ reasonCode: "verification_path_invalid", status: "FAILED" });
      expect(JSON.stringify(result)).not.toContain(root);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("checks named output artifacts without requiring a workspace", async () => {
    const verifier = new WorkspaceWorkVerifier({
      contexts: { loadForExecution: async () => ({ promptSection: "safe", sanitized: {} }) },
    });
    await expect(verifier.verify({
      acceptanceChecks: [{ kind: "ARTIFACT_PRESENT", name: "report.md" }],
      artifacts: [{ name: "report.md", size: 12 }], contextSnapshotId: "context_1",
    })).resolves.toEqual({ status: "PASSED" });
  });

  it("checks non-empty partner text with BODY_PRESENT", async () => {
    const verifier = new WorkspaceWorkVerifier({
      contexts: { loadForExecution: async () => ({ promptSection: "safe", sanitized: {} }) },
    });
    await expect(verifier.verify({
      acceptanceChecks: [{ kind: "BODY_PRESENT" }], artifacts: [], body: "evidence", contextSnapshotId: "context_1",
    })).resolves.toEqual({ status: "PASSED" });
    await expect(verifier.verify({
      acceptanceChecks: [{ kind: "BODY_PRESENT" }], artifacts: [], body: "  ", contextSnapshotId: "context_1",
    })).resolves.toEqual({ reasonCode: "verification_body_missing", status: "FAILED" });
  });
});
