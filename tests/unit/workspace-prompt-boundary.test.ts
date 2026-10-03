import { workspaceReadScopeLine, workspaceRootBoundaryLine } from "../../src/main/infrastructure/workspace/workspace-prompt-boundary.js";

describe("workspace root prompt boundary", () => {
  it("names the authoritative root and the acceptance-check constraint", () => {
    const line = workspaceRootBoundaryLine("I:\\work\\reports\\plugin");
    expect(line).toContain("Workspace root (authoritative): I:\\work\\reports\\plugin");
    expect(line).toContain("FILE_EXISTS");
    expect(line).toContain("FILE_CONTAINS_EXACT");
    expect(line).toContain("can never reference files outside it");
  });

  it("keeps the legacy unavailable wording when there is no workspace", () => {
    expect(workspaceRootBoundaryLine(undefined)).toBe("Workspace: unavailable; workspace tools are disabled.");
  });
});

describe("workspace read scope line", () => {
  // The write-boundary prompt once buried "reading outside is allowed" among four prohibitions,
  // and partners concluded outside paths were off limits entirely (ADR 0024 追记). The line must
  // stay affirmative: a permission stated first, with only writes marked as governed.
  it("states outside reads as a permission and scopes every restriction to writes", () => {
    const line = workspaceReadScopeLine();
    expect(line).toContain("Reads are never confined");
    expect(line).toContain("inside or outside the workspace");
    expect(line).toContain("reading requires no permission");
    expect(line).toContain("Only file writes are governed");
    expect(line).not.toMatch(/do not|never read|refused|cannot read/i);
  });
});
