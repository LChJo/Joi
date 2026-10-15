import { ARTIFACT_ROOT_LABEL, artifactGroupLabel, groupArtifactsForDisplay, isHiddenWorkspaceArtifact, isIndividuallyRenderedArtifact } from "../../src/shared/artifact-presentation";
import type { WorkbenchArtifactDto } from "../../src/shared/joi";

function file(name: string, overrides: Partial<WorkbenchArtifactDto> = {}): WorkbenchArtifactDto {
  return { kind: "FILE", mimeType: "application/octet-stream", name, size: 1, ...overrides };
}

function directory(name: string, directory: string | undefined): WorkbenchArtifactDto {
  return { kind: "DIRECTORY", mimeType: "inode/directory", name, size: 0, ...(directory === undefined ? {} : { directory }) };
}

describe("isIndividuallyRenderedArtifact", () => {
  it("keeps documents individual, including mime parameters and octet-stream fallbacks", () => {
    expect(isIndividuallyRenderedArtifact(file("report.md", { mimeType: "text/markdown" }))).toBe(true);
    expect(isIndividuallyRenderedArtifact(file("partner-result.txt", { mimeType: "text/plain; charset=utf-8" }))).toBe(true);
    expect(isIndividuallyRenderedArtifact(file("notes.md"))).toBe(true);
    expect(isIndividuallyRenderedArtifact(file("readme.TXT"))).toBe(true);
  });

  it("keeps images individual even though workspace capture reports octet-stream", () => {
    for (const name of ["photo.png", "photo.jpg", "photo.jpeg", "photo.gif", "photo.webp", "photo.avif", "photo.bmp"]) {
      expect(isIndividuallyRenderedArtifact(file(name))).toBe(true);
    }
  });

  it("merges code, data, archives and extensionless files", () => {
    for (const artifact of [
      file("app.ts", { mimeType: "text/typescript" }),
      file("config.json", { mimeType: "application/json" }),
      file("data.csv", { mimeType: "text/csv" }),
      file("archive.zip"),
      file("Makefile"),
    ]) expect(isIndividuallyRenderedArtifact(artifact)).toBe(false);
  });

  it("never renders directories individually through the whitelist", () => {
    expect(isIndividuallyRenderedArtifact(directory("notes.md", "reports"))).toBe(false);
  });
});

describe("artifactGroupLabel", () => {
  it("AC-I18N-05 localizes only the missing-directory label, preserving real directory names", () => {
    expect(artifactGroupLabel(undefined, "workspace root")).toBe("workspace root");
    expect(artifactGroupLabel("（工作区根目录）", "workspace root")).toBe("（工作区根目录）");
  });
  it("labels unknown and root directories with the root label", () => {
    expect(artifactGroupLabel(undefined)).toBe(ARTIFACT_ROOT_LABEL);
    expect(artifactGroupLabel("")).toBe(ARTIFACT_ROOT_LABEL);
    expect(artifactGroupLabel("src/main")).toBe("src/main");
  });
});

describe("isHiddenWorkspaceArtifact", () => {
  it("hides VCS and dependency metadata directories at any depth", () => {
    expect(isHiddenWorkspaceArtifact(file("FETCH_HEAD", { directory: ".git" }))).toBe(true);
    expect(isHiddenWorkspaceArtifact(file("aa", { directory: ".git/objects/00" }))).toBe(true);
    expect(isHiddenWorkspaceArtifact(file("index.js", { directory: "node_modules/pkg" }))).toBe(true);
    expect(isHiddenWorkspaceArtifact(directory("00", ".git/objects/00"))).toBe(true);
    expect(isHiddenWorkspaceArtifact(file("app.ts", { directory: "src" }))).toBe(false);
    expect(isHiddenWorkspaceArtifact(file("bundle.zip"))).toBe(false);
  });
});

describe("groupArtifactsForDisplay", () => {
  const identity = (artifact: WorkbenchArtifactDto): WorkbenchArtifactDto | undefined => artifact;

  it("folds consecutive non-whitelisted files into one folder row per directory", () => {
    const groups = groupArtifactsForDisplay([file("a.ts", { directory: "src" }), file("b.ts", { directory: "src" })], identity);
    expect(groups).toEqual([{ directory: "src", items: [expect.objectContaining({ name: "a.ts" }), expect.objectContaining({ name: "b.ts" })], kind: "FOLDER" }]);
  });

  it("breaks folder runs on non-artifact rows and whitelisted files", () => {
    const message = file("report.md", { mimeType: "text/markdown" });
    const groups = groupArtifactsForDisplay([file("a.ts", { directory: "src" }), message, file("b.ts", { directory: "src" })], identity);
    expect(groups.map((group) => group.kind)).toEqual(["FOLDER", "SINGLE", "FOLDER"]);
  });

  it("keeps directories in first-appearance order when runs are interrupted", () => {
    const groups = groupArtifactsForDisplay([file("a.ts", { directory: "src" }), file("b.ts", { directory: "assets" }), file("c.ts", { directory: "src" })], identity);
    expect(groups.map((group) => group.kind === "FOLDER" ? group.directory : "single")).toEqual(["src", "assets", "src"]);
  });

  it("groups root-level and legacy directory-less files under the root group", () => {
    const groups = groupArtifactsForDisplay([file("bundle.zip"), file("legacy.ts")], identity);
    expect(groups).toHaveLength(1);
    const [first] = groups;
    expect(first).toMatchObject({ directory: undefined, kind: "FOLDER" });
    expect(artifactGroupLabel(first?.kind === "FOLDER" ? first.directory : undefined)).toBe(ARTIFACT_ROOT_LABEL);
  });

  it("passes rows without an artifact through as SINGLE", () => {
    const rows: (WorkbenchArtifactDto | undefined)[] = [file("a.ts", { directory: "src" }), undefined, file("b.ts", { directory: "src" })];
    const groups = groupArtifactsForDisplay(rows, (row) => row);
    expect(groups.map((group) => group.kind)).toEqual(["FOLDER", "SINGLE", "FOLDER"]);
  });

  it("drops hidden artifacts entirely without breaking folder runs", () => {
    const groups = groupArtifactsForDisplay([
      file("FETCH_HEAD", { directory: ".git" }),
      directory("00", ".git/objects/00"),
      file("a.ts", { directory: "src" }),
      file("aa", { directory: ".git/objects/00" }),
      file("b.ts", { directory: "src" }),
    ], identity);
    expect(groups).toEqual([{ directory: "src", items: [expect.objectContaining({ name: "a.ts" }), expect.objectContaining({ name: "b.ts" })], kind: "FOLDER" }]);
  });

  it("suppresses DIRECTORY artifacts whose path equals a formed group, even with a whitelisted sibling between", () => {
    const groups = groupArtifactsForDisplay([
      directory("reports", "reports"),
      file("a.md", { directory: "reports", mimeType: "text/markdown" }),
      file("b.ts", { directory: "reports" }),
    ], identity);
    expect(groups.map((group) => group.kind === "FOLDER" ? `folder:${group.directory ?? ""}` : `single:${group.item.name}`))
      .toEqual(["single:a.md", "folder:reports"]);
  });

  it("keeps DIRECTORY artifacts that have no grouped files", () => {
    const groups = groupArtifactsForDisplay([directory("docs", "docs"), file("a.md", { directory: "docs", mimeType: "text/markdown" })], identity);
    expect(groups.map((group) => group.kind)).toEqual(["SINGLE", "SINGLE"]);
  });

  it("suppresses an unknown-path DIRECTORY when a root group forms", () => {
    const groups = groupArtifactsForDisplay([directory("lost", undefined), file("bundle.zip")], identity);
    expect(groups).toEqual([{ directory: undefined, items: [expect.objectContaining({ name: "bundle.zip" })], kind: "FOLDER" }]);
  });
});
