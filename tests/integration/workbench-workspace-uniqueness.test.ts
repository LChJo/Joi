import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("Workbench workspace sharing", () => {
  it("allows more than one Workbench to bind the same workspace root", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const first = await fixture.workbenchRegistry.create({
        name: "第一个 Workbench",
        personaSummary: "private",
        projectLabel: "工程一",
        scopeSummary: "范围一",
      });
      const second = await fixture.workbenchRegistry.create({
        name: "第二个 Workbench",
        personaSummary: "private",
        projectLabel: "工程二",
        scopeSummary: "范围二",
      });

      await fixture.workbenchWorkspaces.bindExisting(first.workbenchId, "C:\\projects\\shared\\");
      await expect(fixture.workbenchWorkspaces.bindExisting(second.workbenchId, "C:\\projects\\shared"))
        .resolves.toMatchObject({ kind: "BOUND", status: "READY" });
      expect(fixture.database.transaction((connection) => connection.prepare(`SELECT root_path FROM workbench_workspace_roots
        WHERE workspace_ref IN (?, ?) ORDER BY workspace_ref`).all(
        `workbench_workspace:${first.workbenchId}`,
        `workbench_workspace:${second.workbenchId}`,
      ))).toEqual([{ root_path: "C:\\projects\\shared" }, { root_path: "C:\\projects\\shared" }]);
    } finally {
      await fixture.close();
    }
  });
});
