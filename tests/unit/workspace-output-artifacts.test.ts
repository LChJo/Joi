import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { captureWorkspaceSnapshot, collectChangedWorkspaceArtifacts } from "../../src/main/infrastructure/workspace/workspace-output-artifacts.js";

describe("workspace output artifacts", () => {
  it("returns only files created or modified during a partner run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-workspace-artifacts-"));
    try {
      await writeFile(path.join(root, "existing.txt"), "before", "utf8");
      const before = await captureWorkspaceSnapshot(root);
      await writeFile(path.join(root, "existing.txt"), "after", "utf8");
      await mkdir(path.join(root, "reports"));
      await writeFile(path.join(root, "reports", "evidence.md"), "# Evidence", "utf8");

      await expect(collectChangedWorkspaceArtifacts(root, before)).resolves.toEqual([
        { mimeType: "text/plain", name: "existing.txt", size: 5 },
        { mimeType: "text/markdown", name: "evidence.md", size: 10 },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not expose absolute paths when the workspace is unavailable", async () => {
    const missing = path.join(os.tmpdir(), "joi-workspace-artifacts-missing");
    await expect(captureWorkspaceSnapshot(missing)).resolves.toHaveLength(0);
    await expect(collectChangedWorkspaceArtifacts(missing, new Map())).resolves.toEqual([]);
  });
});
