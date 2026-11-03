import { createWorkResult, summarizeWorkResult } from "../../src/main/domain/work/work-result.js";

describe("WorkResult", () => {
  it("abbreviates absolute paths and redacts common credentials from bounded summaries", () => {
    const summary = summarizeWorkResult(
      "done C:\\Users\\owner\\deep\\private.txt /home/owner/deep/private \\\\server\\share\\a\\b\\c\\d token=super-secret-token Bearer abcdefghijklmnop",
      "COMPLETED",
    );
    expect(summary).toContain("C:\\…\\owner\\deep\\private.txt");
    expect(summary).toContain("/…/owner/deep/private");
    expect(summary).toContain("\\\\server\\share\\…\\b\\c\\d");
    expect(summary).not.toMatch(/C:\\Users|\/home\/owner|\\\\server\\share\\a|super-secret-token|abcdefghijklmnop/u);
  });

  it("sanitizes an engine-supplied summary as well as a derived one", () => {
    const result = createWorkResult({
      actionId: "action", artifacts: [], workbenchId: "workbench", body: "restricted body", createdAt: "2026-08-02T00:00:00.000Z",
      isLate: false, partnerRevisionId: "revision", resultId: "result", runId: "run", status: "COMPLETED",
      summary: "artifact at D:/private/a/b/out.txt api_key=private-key-value", workId: "work",
    });
    expect(result.summary).toContain("D:/…/a/b/out.txt");
    expect(result.summary).not.toContain("private-key-value");
  });

  it("derives a fallback summary and clones artifacts", () => {
    const sourceArtifact = { artifactRef: "artifact:one", name: "report.txt", size: 12 };
    const artifacts = [sourceArtifact];
    const result = createWorkResult({
      actionId: "action", artifacts, workbenchId: "workbench", body: "   ", createdAt: "2026-08-02T00:00:00.000Z",
      isLate: false, partnerRevisionId: "revision", resultId: "result", runId: "run", status: "FAILED", workId: "work",
    });
    sourceArtifact.name = "changed.txt";
    expect(result.summary).toBe("Partner run failed.");
    expect(result.artifacts[0]?.name).toBe("report.txt");
  });
});
