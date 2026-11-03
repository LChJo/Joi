import {
  workResultArtifactId,
  workspaceArtifactReference,
  workspaceArtifactRelativePath,
} from "../../src/main/domain/work/workspace-artifact-reference.js";

describe("workspace artifact references", () => {
  it("round-trips a safe workspace-relative path and creates a stable result artifact id", () => {
    const reference = workspaceArtifactReference("reports/final.md");

    expect(reference).toBe("workspace:reports/final.md");
    expect(workspaceArtifactRelativePath(reference)).toBe("reports/final.md");
    expect(workResultArtifactId("result-1", 2)).toBe("work_result_artifact:result-1:2");
  });

  it.each([
    undefined,
    "external:report.md",
    "workspace:",
    "workspace:/report.md",
    "workspace:reports\\report.md",
    "workspace:reports\0report.md",
    "workspace:reports//report.md",
    "workspace:reports/./report.md",
    "workspace:reports/../report.md",
    "workspace:C:/report.md",
  ])("rejects a non-workspace or unsafe reference: %s", (reference) => {
    expect(workspaceArtifactRelativePath(reference)).toBeUndefined();
  });
});
