/* In-memory async ports resolve immediately. */
/* eslint-disable @typescript-eslint/require-await */
import { AvatarWorkspaceService } from "../../src/main/application/joi/avatar-workspace-service.js";
import type { AvatarWorkspaceSummary } from "../../src/main/application/ports/avatar-context.js";
import { createAvatar } from "../../src/main/domain/avatar/avatar.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

const avatar = createAvatar({
  avatarId: "avatar-a", createdAt: "2026-08-02T00:00:00.000Z", memoryNamespaceId: "memory-a", name: "A",
  personaRevisionId: "persona-a", personaSummary: "Persona", project: { label: "Project" }, scopeSummary: "Scope",
  taskContext: { activeWorkIds: [], summary: "" },
});
const managed: AvatarWorkspaceSummary = { displayName: "A 工作区", kind: "MANAGED", status: "PROVISIONING", workspaceRef: "avatar_workspace:avatar-a" };

describe("AvatarWorkspaceService", () => {
  it("returns safe workspace DTOs for get, bind and rebuild and emits no opaque ref", async () => {
    let current: AvatarWorkspaceSummary | null = { ...managed, failureReasonCode: "old_failure" };
    const events: unknown[] = [];
    const service = new AvatarWorkspaceService({
      avatars: { getAvatar: async () => avatar, listSummaries: async () => [] }, clock: new TestClock(),
      events: { emit: async (...event) => { events.push(event); } }, ids: new TestIds(),
      repository: {
        bindExisting: async (input) => (current = { displayName: input.displayName, kind: "BOUND", status: "READY", workspaceRef: managed.workspaceRef }),
        getWorkspace: async () => current,
        hasNonTerminalFileWork: async () => false,
        requestManagedRebuild: async () => (current = managed),
      },
    });
    await expect(service.get("avatar-a")).resolves.toEqual({ displayName: "A 工作区", failureReasonCode: "old_failure", kind: "MANAGED", status: "PROVISIONING" });
    await expect(service.bindExisting("avatar-a", "C:\\projects\\docs\\")).resolves.toEqual({ displayName: "docs", kind: "BOUND", status: "READY" });
    await expect(service.rebuildManaged("avatar-a")).resolves.toEqual({ displayName: "A 工作区", kind: "MANAGED", status: "PROVISIONING" });
    expect(JSON.stringify(events)).not.toContain("workspaceRef");
  });

  it("rejects missing workspaces, Avatars, empty paths and active file work", async () => {
    let avatarExists = true;
    let busy = false;
    let workspace: AvatarWorkspaceSummary | null = null;
    const service = new AvatarWorkspaceService({
      avatars: { getAvatar: async () => avatarExists ? avatar : null, listSummaries: async () => [] },
      clock: new TestClock(), ids: new TestIds(),
      repository: {
        bindExisting: async () => managed,
        getWorkspace: async () => workspace,
        hasNonTerminalFileWork: async () => busy,
        requestManagedRebuild: async () => managed,
      },
    });
    await expect(service.get("avatar-a")).rejects.toMatchObject({ code: "avatar_workspace_not_found" });
    workspace = managed;
    await expect(service.bindExisting("avatar-a", " ")).rejects.toMatchObject({ code: "avatar_workspace_path_required" });
    avatarExists = false;
    await expect(service.rebuildManaged("avatar-a")).rejects.toMatchObject({ code: "avatar_not_found" });
    avatarExists = true;
    busy = true;
    await expect(service.bindExisting("avatar-a", "C:\\work")).rejects.toMatchObject({ code: "avatar_workspace_busy" });
  });
});
