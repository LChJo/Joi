/* In-memory async ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { AvatarManagementService } from "../../src/main/application/joi/avatar-management-service.js";
import type { AvatarDetailDto } from "../../src/shared/joi.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const detail: AvatarDetailDto = {
  activeWork: [], avatarId: "avatar-a", instances: [], name: "A", personaRevisionId: "persona-a",
  projectLabel: "Project", recentResults: [], responsibility: "Scope", updatedAt: "2026-08-02T00:00:00.000Z",
  workspace: { displayName: "A 工作区", kind: "MANAGED", status: "READY" },
};

describe("AvatarManagementService", () => {
  it("loads and updates every safe field while emitting revision metadata only", async () => {
    const updates: unknown[] = [];
    const events: unknown[] = [];
    const service = new AvatarManagementService({
      clock: new TestClock("2026-08-02T01:00:00.000Z"),
      events: { emit: async (...event) => { events.push(event); } },
      ids: new TestIds(),
      repository: {
        getDetail: async () => detail,
        updateContext: async (input) => { updates.push(input); return { ...detail, personaRevisionId: input.personaRevisionId ?? detail.personaRevisionId, updatedAt: input.updatedAt }; },
      },
    });
    await expect(service.get("avatar-a")).resolves.toEqual(detail);
    await expect(service.update("avatar-a", { name: " Updated ", persona: " New persona ", projectLabel: " New project ", responsibility: " New scope " }))
      .resolves.toMatchObject({ personaRevisionId: "persona_revision_test_0001" });
    expect(updates[0]).toMatchObject({
      avatarId: "avatar-a", name: "Updated", personaBody: "New persona", personaRevisionId: "persona_revision_test_0001",
      projectLabel: "New project", responsibility: "New scope",
    });
    expect(events).toEqual([["avatar.context.updated", "avatar-a", expect.objectContaining({ avatarId: "avatar-a", personaRevisionId: "persona_revision_test_0001" })]]);
  });

  it("covers partial updates without creating a persona revision", async () => {
    const updates: Record<string, unknown>[] = [];
    const service = new AvatarManagementService({
      clock: new TestClock(), ids: new TestIds(),
      repository: { getDetail: async () => detail, updateContext: async (input) => { updates.push(input); return detail; } },
    });
    await service.update("avatar-a", { name: "Name" });
    await service.update("avatar-a", { persona: "Persona" });
    await service.update("avatar-a", { projectLabel: "Project" });
    await service.update("avatar-a", { responsibility: "Scope" });
    expect(updates).toHaveLength(4);
    expect(updates[0]).not.toHaveProperty("personaRevisionId");
    expect(updates[1]).toHaveProperty("personaRevisionId");
  });

  it("rejects empty, invalid and missing Avatar updates with stable codes", async () => {
    let missing = false;
    const service = new AvatarManagementService({
      clock: new TestClock(), ids: new TestIds(),
      repository: {
        getDetail: async () => missing ? null : detail,
        updateContext: async () => missing ? null : detail,
      },
    });
    await expect(service.update("avatar-a", {})).rejects.toMatchObject({ code: "avatar_update_empty" });
    await expect(service.update("avatar-a", { name: " " })).rejects.toMatchObject({ code: "avatar_name_invalid" });
    await expect(service.update("avatar-a", { persona: " " })).rejects.toMatchObject({ code: "avatar_persona_invalid" });
    await expect(service.update("avatar-a", { projectLabel: " " })).rejects.toMatchObject({ code: "avatar_project_label_invalid" });
    await expect(service.update("avatar-a", { responsibility: " " })).rejects.toMatchObject({ code: "avatar_scope_invalid" });
    await expect(service.update("avatar-a", { name: "x".repeat(81) })).rejects.toMatchObject({ code: "avatar_name_invalid" });
    missing = true;
    await expect(service.get("avatar-missing")).rejects.toMatchObject({ code: "avatar_not_found" });
    await expect(service.update("avatar-missing", { name: "Name" })).rejects.toMatchObject({ code: "avatar_not_found" });
  });
});
