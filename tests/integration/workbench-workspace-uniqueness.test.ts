import { createRuntimeFixture } from "../support/runtime-fixture.js";

describe("Workbench workspace ownership", () => {
  it("rejects binding one workspace root to more than one Workbench", async () => {
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
        .rejects.toMatchObject({ code: "workbench_workspace_already_bound" });
    } finally {
      await fixture.close();
    }
  });
});
