/* In-memory async ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { WorkbenchWorkspaceService } from "../../src/main/application/joi/workbench-workspace-service.js";
import type { WorkbenchWorkspaceSummary } from "../../src/main/application/ports/workbench-context.js";
import { createWorkbench } from "../../src/main/domain/workbench/workbench.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const workbench = createWorkbench({
  workbenchId: "workbench-a", createdAt: "2026-08-02T00:00:00.000Z", memoryNamespaceId: "memory-a", name: "A",
  personaRevisionId: "persona-a", personaSummary: "Persona", project: { label: "Project" }, scopeSummary: "Scope",
  taskContext: { activeWorkIds: [], summary: "" },
});
const managed: WorkbenchWorkspaceSummary = { displayName: "A 工作区", kind: "MANAGED", status: "PROVISIONING", workspaceRef: "workbench_workspace:workbench-a" };

describe("WorkbenchWorkspaceService", () => {
  it("returns safe workspace DTOs for get, bind and rebuild and emits no opaque ref", async () => {
    let current: WorkbenchWorkspaceSummary | null = { ...managed, failureReasonCode: "old_failure" };
    const events: unknown[] = [];
    const service = new WorkbenchWorkspaceService({
      workbenches: { getWorkbench: async () => workbench, listSummaries: async () => [] }, clock: new TestClock(),
      events: { emit: async (...event) => { events.push(event); } }, ids: new TestIds(),
      repository: {
        bindExisting: async (input) => (current = { displayName: input.displayName, kind: "BOUND", status: "READY", workspaceRef: managed.workspaceRef }),
        getWorkspace: async () => current,
        hasNonTerminalFileWork: async () => false,
        requestManagedRebuild: async () => (current = managed),
      },
    });
    await expect(service.get("workbench-a")).resolves.toEqual({ displayName: "A 工作区", failureReasonCode: "old_failure", kind: "MANAGED", status: "PROVISIONING" });
    await expect(service.bindExisting("workbench-a", "C:\\projects\\docs\\")).resolves.toEqual({ displayName: "docs", kind: "BOUND", status: "READY" });
    await expect(service.rebuildManaged("workbench-a")).resolves.toEqual({ displayName: "A 工作区", kind: "MANAGED", status: "PROVISIONING" });
    expect(JSON.stringify(events)).not.toContain("workspaceRef");
  });

  it("rejects missing workspaces, Workbenches, empty paths and active file work", async () => {
    let workbenchExists = true;
    let busy = false;
    let workspace: WorkbenchWorkspaceSummary | null = null;
    const service = new WorkbenchWorkspaceService({
      workbenches: { getWorkbench: async () => workbenchExists ? workbench : null, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      repository: {
        bindExisting: async () => managed,
        getWorkspace: async () => workspace,
        hasNonTerminalFileWork: async () => busy,
        requestManagedRebuild: async () => managed,
      },
    });
    await expect(service.get("workbench-a")).rejects.toMatchObject({ code: "workbench_workspace_not_found" });
    workspace = managed;
    await expect(service.bindExisting("workbench-a", " ")).rejects.toMatchObject({ code: "workbench_workspace_path_required" });
    workbenchExists = false;
    await expect(service.rebuildManaged("workbench-a")).rejects.toMatchObject({ code: "workbench_not_found" });
    workbenchExists = true;
    busy = true;
    await expect(service.bindExisting("workbench-a", "C:\\work")).rejects.toMatchObject({ code: "workbench_workspace_busy" });
  });
});
