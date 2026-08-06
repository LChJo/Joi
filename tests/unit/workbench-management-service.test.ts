/* In-memory async ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { WorkbenchManagementService } from "../../src/main/application/joi/workbench-management-service.js";
import type { WorkbenchDetailDto } from "../../src/shared/joi.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const detail: WorkbenchDetailDto = {
  activeWork: [], workbenchId: "workbench-a", instances: [], name: "A", personaRevisionId: "persona-a",
  projectLabel: "Project", recentResults: [], responsibility: "Scope", updatedAt: "2026-08-02T00:00:00.000Z",
  workspace: { displayName: "A 工作区", kind: "MANAGED", status: "READY" },
};

describe("WorkbenchManagementService", () => {
  it("loads and updates every safe field while emitting revision metadata only", async () => {
    const updates: unknown[] = [];
    const events: unknown[] = [];
    const service = new WorkbenchManagementService({
      clock: new TestClock("2026-08-02T01:00:00.000Z"),
      events: { emit: async (...event) => { events.push(event); } },
      ids: new TestIds(),
      repository: {
        getDetail: async () => detail,
        updateContext: async (input) => { updates.push(input); return { ...detail, personaRevisionId: input.personaRevisionId ?? detail.personaRevisionId, updatedAt: input.updatedAt }; },
      },
    });
    await expect(service.get("workbench-a")).resolves.toEqual(detail);
    await expect(service.update("workbench-a", { name: " Updated ", persona: " New persona ", projectLabel: " New project ", responsibility: " New scope " }))
      .resolves.toMatchObject({ personaRevisionId: "persona_revision_test_0001" });
    expect(updates[0]).toMatchObject({
      workbenchId: "workbench-a", name: "Updated", personaBody: "New persona", personaRevisionId: "persona_revision_test_0001",
      projectLabel: "New project", responsibility: "New scope",
    });
    expect(events).toEqual([["workbench.context.updated", "workbench-a", expect.objectContaining({ workbenchId: "workbench-a", personaRevisionId: "persona_revision_test_0001" })]]);
  });

  it("covers partial updates without creating a persona revision", async () => {
    const updates: Record<string, unknown>[] = [];
    const service = new WorkbenchManagementService({
      clock: new TestClock(), ids: new TestIds(),
      repository: { getDetail: async () => detail, updateContext: async (input) => { updates.push(input); return detail; } },
    });
    await service.update("workbench-a", { name: "Name" });
    await service.update("workbench-a", { persona: "Persona" });
    await service.update("workbench-a", { projectLabel: "Project" });
    await service.update("workbench-a", { responsibility: "Scope" });
    expect(updates).toHaveLength(4);
    expect(updates[0]).not.toHaveProperty("personaRevisionId");
    expect(updates[1]).toHaveProperty("personaRevisionId");
  });

  it("rejects empty, invalid and missing Workbench updates with stable codes", async () => {
    let missing = false;
    const service = new WorkbenchManagementService({
      clock: new TestClock(), ids: new TestIds(),
      repository: {
        getDetail: async () => missing ? null : detail,
        updateContext: async () => missing ? null : detail,
      },
    });
    await expect(service.update("workbench-a", {})).rejects.toMatchObject({ code: "workbench_update_empty" });
    await expect(service.update("workbench-a", { name: " " })).rejects.toMatchObject({ code: "workbench_name_invalid" });
    await expect(service.update("workbench-a", { persona: " " })).rejects.toMatchObject({ code: "workbench_persona_invalid" });
    await expect(service.update("workbench-a", { projectLabel: " " })).rejects.toMatchObject({ code: "workbench_project_label_invalid" });
    await expect(service.update("workbench-a", { responsibility: " " })).rejects.toMatchObject({ code: "workbench_scope_invalid" });
    await expect(service.update("workbench-a", { name: "x".repeat(81) })).rejects.toMatchObject({ code: "workbench_name_invalid" });
    missing = true;
    await expect(service.get("workbench-missing")).rejects.toMatchObject({ code: "workbench_not_found" });
    await expect(service.update("workbench-missing", { name: "Name" })).rejects.toMatchObject({ code: "workbench_not_found" });
  });
});
