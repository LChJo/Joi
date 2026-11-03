import { ARTIFACT_ROOT_LABEL, artifactGroupLabel, groupArtifactsForDisplay, isHiddenWorkspaceArtifact, isIndividuallyRenderedArtifact } from "../../src/shared/artifact-presentation";
import type { WorkbenchArtifactDto } from "../../src/shared/joi";

function file(name: string, directory?: string): WorkbenchArtifactDto {
  return { kind: "FILE", mimeType: "text/markdown", name, size: 1, ...(directory === undefined ? {} : { directory }) };
}
const identity = (item: WorkbenchArtifactDto) => item;

describe("current-round artifact presentation", () => {
  it("uses the same individual eligibility for documents, images, code and data", () => {
    for (const name of ["report.md", "photo.png", "code.ts", "data.json"]) {
      expect(isIndividuallyRenderedArtifact(file(name))).toBe(true);
    }
    expect(isIndividuallyRenderedArtifact({ kind: "DIRECTORY", name: "reports", mimeType: "inode/directory" })).toBe(false);
  });

  it("localizes only the missing-directory label", () => {
    expect(artifactGroupLabel(undefined)).toBe(ARTIFACT_ROOT_LABEL);
    expect(artifactGroupLabel("", "workspace root")).toBe("workspace root");
    expect(artifactGroupLabel("reports", "workspace root")).toBe("reports");
    expect(artifactGroupLabel("（工作区根目录）", "workspace root")).toBe("（工作区根目录）");
  });

  it("hides tooling directories at every depth", () => {
    for (const directory of [".git", "src/.cache", "tools/node_modules/pkg", "__pycache__", "tools/__pycache__"]) {
      expect(isHiddenWorkspaceArtifact({ directory })).toBe(true);
    }
    expect(isHiddenWorkspaceArtifact(file("report.md", "reports"))).toBe(false);
    expect(isHiddenWorkspaceArtifact(file("report.md"))).toBe(false);
  });

  it("keeps one, two or three files as individual rows regardless of type", () => {
    for (const count of [1, 2, 3]) {
      const files = Array.from({ length: count }, (_, index) => file(String(index) + ".ts", "src"));
      expect(groupArtifactsForDisplay(files, identity)).toEqual(files.map(item => ({ kind: "SINGLE", item })));
    }
  });

  it("collapses four files once even when document and code types are mixed", () => {
    const first = file("a.md", "reports");
    const files = [first, ...["b.ts", "c.png", "d.json"].map(name => file(name, "reports"))];
    const items = [first, file("single.md", "other"), ...files.slice(1)];
    const groups = groupArtifactsForDisplay(items, identity);
    expect(groups).toEqual([{ kind: "FOLDER", directory: "reports", items: files }, { kind: "SINGLE", item: items[1] }]);
  });

  it("suppresses redundant directory markers and hidden files", () => {
    const first = file("a.md", "reports");
    const second = file("b.ts", "reports");
    const files = [first, second];
    const directory: WorkbenchArtifactDto = { kind: "DIRECTORY", directory: "reports", name: "reports", mimeType: "inode/directory", size: 0 };
    expect(groupArtifactsForDisplay([directory, first, file("cache", ".cache"), second], identity))
      .toEqual(files.map(item => ({ kind: "SINGLE", item })));
  });

  it("keeps already aggregated folders intact and groups workspace-root files", () => {
    const aggregate: WorkbenchArtifactDto = { kind: "DIRECTORY", directory: "reports", name: "reports", mimeType: "inode/directory", size: 0, fileCount: 100 };
    const files = Array.from({ length: 4 }, (_, index) => file(String(index) + ".md"));
    expect(groupArtifactsForDisplay([aggregate, ...files], identity)).toEqual([
      { kind: "SINGLE", item: aggregate }, { kind: "FOLDER", directory: undefined, items: files },
    ]);
  });

  it("keeps conversation boundaries in order", () => {
    const rows: (WorkbenchArtifactDto | undefined)[] = [file("a.ts", "src"), undefined, file("b.ts", "src")];
    expect(groupArtifactsForDisplay(rows, item => item).map(group => group.kind)).toEqual(["SINGLE", "SINGLE", "SINGLE"]);
  });

  it("keeps a standalone directory with no file marker", () => {
    const item: WorkbenchArtifactDto = { kind: "DIRECTORY", directory: "empty", name: "empty", mimeType: "inode/directory", size: 0 };
    expect(groupArtifactsForDisplay([item], identity)).toEqual([{ kind: "SINGLE", item }]);
  });
});
