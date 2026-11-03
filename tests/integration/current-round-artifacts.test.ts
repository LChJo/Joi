import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";
import { createGoalEvidenceFixture } from "../support/goal-evidence-fixture.js";
import { GoalArtifactPreviewCache } from "../../src/main/infrastructure/persistence/sqlite-goal-artifacts.js";

const file = (relativePath: string) => ({ artifactRef: `workspace:${relativePath}`, name: relativePath.split("/").at(-1), mimeType: "text/markdown", size: 4 });

it("projects only this reopened round, counts files once and hides stored cache and directory entries", async () => {
  const fixture = await createGoalEvidenceFixture([{}, {}]);
  try {
    const start = new Date(fixture.clock.now().getTime() + 1_000).toISOString();
    fixture.database.transaction(db => {
      db.prepare("UPDATE joi_inbox_messages SET reopened_at=? WHERE input_id='goal'").run(start);
      db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-1'").run(JSON.stringify([file("old.md")]));
      db.prepare("UPDATE work_results SET created_at=?,artifacts_json=? WHERE result_id='result-2'").run(start, JSON.stringify([
        file("reports/new.md"), file("reports/new.md"), file("reports/second.md"),
        { artifactRef: "workspace:reports", name: "reports", mimeType: "inode/directory", size: 0 },
        file("__pycache__/junk.pyc"), file("nested/node_modules/pkg/index.md"),
      ]));
    });
    const reader = new SqliteJoiHomeFeedRepository(fixture.database);
    const page = await reader.listGoalArtifacts("goal", {});
    expect(page?.items.map(item => item.name)).toEqual(["new.md", "second.md"]);
    expect(page?.nextCursor).toBeUndefined();
    fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET reopened_at=NULL WHERE input_id='goal'").run());
    expect((await reader.listGoalArtifacts("goal", {}))?.items.map(item => item.name)).toEqual(["old.md", "new.md", "second.md"]);
  } finally { await fixture.close(); }
});

it("collapses a whole directory before paging, including documents, and opens its validated parent", async () => {
  const fixture = await createGoalEvidenceFixture([{}]);
  try {
    const workspace = path.join(fixture.root, "workspace");
    await mkdir(path.join(workspace, "reports"), { recursive: true });
    for (let index = 0; index < 25; index++) await writeFile(path.join(workspace, "reports", `${String(index).padStart(2, "0")}.md`), "done");
    await fixture.workbenchWorkspaces.bindExisting(fixture.workbenchId, workspace);
    fixture.database.transaction(db => db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-1'").run(JSON.stringify(
      Array.from({ length: 25 }, (_, index) => file(`reports/${String(index).padStart(2, "0")}.md`)),
    )));
    const page = await new SqliteJoiHomeFeedRepository(fixture.database).listGoalArtifacts("goal", { limit: 1 });
    expect(page?.items).toEqual([expect.objectContaining({ name: "reports", directory: "reports", kind: "DIRECTORY", fileCount: 25 })]);
    expect(page?.nextCursor).toBeUndefined();
    const artifactId = page?.items[0]?.artifactId;
    if (artifactId === undefined) throw new Error("Missing folder open identity");
    await fixture.workbenchAgents.openArtifact({ artifactId, mode: "OPEN_FOLDER", source: "GOAL", sourceId: "goal", workbenchId: fixture.workbenchId });
    expect(fixture.artifactOpenCalls.at(-1)).toMatchObject({ kind: "DIRECTORY", targetPath: path.join(workspace, "reports") });
  } finally { await fixture.close(); }
});

it("does not merge equal relative paths from different physical Work directories", async () => {
  const fixture = await createGoalEvidenceFixture([{}, {}]);
  try {
    fixture.database.transaction(db => {
      db.prepare("UPDATE work_results SET artifacts_json=?").run(JSON.stringify([file("report.md")]));
      for (let index = 1; index <= 2; index++) db.prepare(`INSERT INTO work_run_directories
        (work_id,workbench_id,kind,root_path,status,created_at) VALUES (?,?,'MANAGED',?,'READY',?)`)
        .run(`work-${String(index)}`, fixture.workbenchId, path.join(fixture.root, `run-${String(index)}`), fixture.clock.now().toISOString());
    });
    expect((await new SqliteJoiHomeFeedRepository(fixture.database).listGoalArtifacts("goal", {}))?.items).toHaveLength(2);
  } finally { await fixture.close(); }
});

it("invalidates an unchanged preview when the goal is reopened and permits the validated workspace root folder", async () => {
  const fixture = await createGoalEvidenceFixture([{}]);
  try {
    const workspace = path.join(fixture.root, "workspace");
    await mkdir(workspace);
    await fixture.workbenchWorkspaces.bindExisting(fixture.workbenchId, workspace);
    fixture.database.transaction(db => db.prepare("UPDATE work_results SET artifacts_json=? WHERE result_id='result-1'").run(JSON.stringify(
      Array.from({ length: 4 }, (_, index) => file(String(index) + ".md")),
    )));
    const cache = new GoalArtifactPreviewCache();
    const first = fixture.database.transaction(db => cache.read(db, "goal", fixture.workbenchId));
    expect(first).toMatchObject({ artifactCount: 4, artifacts: [{ kind: "DIRECTORY", fileCount: 4 }] });
    const artifactId = first.artifacts?.[0]?.artifactId;
    if (artifactId === undefined) throw new Error("Missing root folder identity");
    await fixture.workbenchAgents.openArtifact({ artifactId, mode: "OPEN_FOLDER", source: "GOAL", sourceId: "goal", workbenchId: fixture.workbenchId });
    expect(fixture.artifactOpenCalls.at(-1)).toMatchObject({ kind: "DIRECTORY", targetPath: workspace });
    fixture.database.transaction(db => db.prepare("UPDATE joi_inbox_messages SET reopened_at=? WHERE input_id='goal'").run(new Date(fixture.clock.now().getTime() + 1_000).toISOString()));
    expect(fixture.database.transaction(db => cache.read(db, "goal", fixture.workbenchId))).toEqual({});
  } finally { await fixture.close(); }
});
