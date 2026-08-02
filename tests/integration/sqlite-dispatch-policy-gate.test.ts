import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import type { WorkItem } from "../../src/main/domain/work/work.js";
import { SqliteDispatchPolicyGate } from "../../src/main/infrastructure/persistence/sqlite-dispatch-policy-gate.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("SQLite dispatch policy gate", () => {
  it("allows NONE without a lease, blocks all A2A file work, and gates local file work on the Avatar workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-dispatch-policy-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const partners = new PartnerRegistryService({ clock, ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const local = await partners.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [] });
      const remote = await partners.add({ capabilities: [], displayName: "Remote", kind: "a2a", skills: [], tools: [] });
      database.transaction((connection) => connection.prepare(`INSERT INTO avatars
        (avatar_id, name, persona_revision_id, persona_summary, scope_summary, project_label,
         memory_namespace_id, status, created_at, updated_at)
        VALUES ('avatar-policy', 'A', 'persona-policy', 'persona', 'scope', 'project', 'memory-policy', 'ACTIVE', ?, ?)`)
        .run(clock.now().toISOString(), clock.now().toISOString()));
      const gate = new SqliteDispatchPolicyGate({ clock, database });
      const item = (accessMode: WorkItem["accessMode"]): WorkItem => ({
        accessMode, avatarId: "avatar-policy", createdAt: clock.now().toISOString(), status: "PLANNED",
        title: "task", updatedAt: clock.now().toISOString(), workId: `work-${accessMode}`,
      });
      const localPin = { partnerId: local.partnerId, partnerRevisionId: local.partnerRevisionId, registryRevision: local.registryRevision };
      const remotePin = { partnerId: remote.partnerId, partnerRevisionId: remote.partnerRevisionId, registryRevision: remote.registryRevision };

      await expect(gate.evaluate(item("NONE"), remotePin)).resolves.toEqual({ allowed: true });
      await expect(gate.evaluate(item("READ"), remotePin)).resolves.toEqual({ allowed: false, reason: "a2a_workspace_access_forbidden" });
      await expect(gate.evaluate(item("WRITE"), localPin)).resolves.toEqual({ allowed: false, reason: "avatar_workspace_not_ready" });

      database.transaction((connection) => connection.prepare(
        "UPDATE avatar_workspace_bindings SET status = 'READY' WHERE avatar_id = 'avatar-policy'",
      ).run());
      await expect(gate.evaluate(item("READ"), localPin)).resolves.toEqual({ allowed: true });
      database.transaction((connection) => {
        connection.prepare(`INSERT INTO work_items
          (work_id, avatar_id, title, intent_json, access_mode, status, created_at, updated_at)
          VALUES ('lease-work', 'avatar-policy', 'lease owner', '{}', 'WRITE', 'RUNNING', ?, ?)`)
          .run(clock.now().toISOString(), clock.now().toISOString());
        connection.prepare(`INSERT INTO workspace_leases
          (workspace_ref, work_id, access_mode, lease_owner, generation, expires_at)
          VALUES ('avatar_workspace:avatar-policy', 'lease-work', 'WRITE', 'owner', 1, '2026-07-15T13:00:00.000Z')`).run();
      });
      await expect(gate.evaluate(item("READ"), localPin)).resolves.toEqual({ allowed: false, reason: "workspace_lease_conflict" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
