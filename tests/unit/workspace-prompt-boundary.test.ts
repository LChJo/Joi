import { workspaceRootBoundaryLine } from "../../src/main/infrastructure/workspace/workspace-prompt-boundary.js";

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
