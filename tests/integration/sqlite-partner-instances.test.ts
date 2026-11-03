import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { SqlitePartnerInstanceMessageStore } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-message-store.js";
import { SqlitePartnerInstanceRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-instance-repository.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

describe("SQLite partner instances", () => {
  it("persists instances, recovers crashed ones at boot and round-trips conversation messages", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-instances-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const database = await openRuntimeDatabaseFixture(databasePath);
    try {
      database.transaction((connection) => connection.prepare(`INSERT INTO workbenches
        (workbench_id, name, persona_revision_id, persona_summary, scope_summary, project_label, memory_namespace_id, status, created_at, updated_at)
        VALUES ('workbench_test', 'A', 'persona_test', 'persona', 'scope', 'project', 'memory_test', 'ACTIVE', '2026-07-29T10:00:00.000Z', '2026-07-29T10:00:00.000Z')`).run());
      const partners = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const partner = await partners.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [] });
      const repository = new SqlitePartnerInstanceRepository(database);

      const resident = await repository.create({ workbenchId: "workbench_test", createdAt: "2026-07-29T10:00:00.000Z", engine: "pi-core", instanceId: "instance_resident", partnerId: partner.partnerId, partnerRevisionId: partner.partnerRevisionId, sessionPolicy: "RESIDENT" });
      await repository.create({ workbenchId: "workbench_test", createdAt: "2026-07-29T10:00:00.000Z", engine: "pi-core", instanceId: "instance_ephemeral", partnerId: partner.partnerId, partnerRevisionId: partner.partnerRevisionId, sessionPolicy: "EPHEMERAL" });
      expect(resident).toMatchObject({ sessionPolicy: "RESIDENT", status: "IDLE" });
      // Resident caps count RESIDENT instances only; the EPHEMERAL instance above is excluded.
      expect(await repository.countActive("workbench_test", partner.partnerId)).toBe(1);
      expect(await repository.countActiveGlobal()).toBe(1);

      await repository.setStatusBusy("instance_resident", "2026-07-29T10:01:00.000Z");
      await repository.setStatusBusy("instance_ephemeral", "2026-07-29T10:01:00.000Z");
      await expect(repository.recoverCrashed("2026-07-29T10:05:00.000Z")).resolves.toEqual({ ephemeralDisposed: 1, residentRecovered: 1 });
      expect((await repository.get("instance_resident"))?.status).toBe("IDLE");
      const recoveredEphemeral = await repository.get("instance_ephemeral");
      expect(recoveredEphemeral).toMatchObject({ disposalReason: "crash", status: "DISPOSED" });
      expect(await repository.listActive({ workbenchId: "workbench_test", partnerId: partner.partnerId })).toHaveLength(1);

      await repository.markTurnComplete("instance_resident", "2026-07-29T10:06:00.000Z", "partner_instance_messages:instance_resident");
      expect((await repository.get("instance_resident"))?.externalSessionRef).toBe("partner_instance_messages:instance_resident");

      const messages = new SqlitePartnerInstanceMessageStore(database);
      expect(await messages.load("instance_resident")).toBeNull();
      await messages.save("instance_resident", [{ content: "hello", role: "user" }, { content: "hi", role: "assistant" }]);
      expect(await messages.load("instance_resident")).toEqual([{ content: "hello", role: "user" }, { content: "hi", role: "assistant" }]);

      database.transaction((connection) => connection.prepare(
        "INSERT INTO partner_instance_messages (message_id, instance_id, sequence, message_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run("corrupt_row", "instance_resident", 5, "{not json", "2026-07-29T10:07:00.000Z"));
      expect(await messages.load("instance_resident")).toHaveLength(2);

      await messages.clear("instance_resident");
      expect(await messages.load("instance_resident")).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
