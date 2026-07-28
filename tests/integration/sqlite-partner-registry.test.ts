import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("SQLite partner registry", () => {
  it("persists immutable revisions and restores the active revision after restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-partners-"));
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      let service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      const first = await service.add({ capabilities: ["research"], displayName: "Local Pi", kind: "local-pi", skills: ["web"], tools: ["read"], workspaceRef: "workspace-ref" });
      const second = await service.update(first.partnerId, { capabilities: ["research", "write"], displayName: "Local Pi", skills: ["web"], tools: ["read", "edit"] });
      await service.disable(first.partnerId);
      expect((await new SqlitePartnerRegistryRepository(database).getRevision(first.partnerRevisionId))?.status).toBe("ACTIVE");
      expect((await new SqlitePartnerRegistryRepository(database).getRevision(second.partnerRevisionId))?.status).toBe("ACTIVE");
      database.close();

      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      service = new PartnerRegistryService({ clock: new TestClock(), ids: new TestIds(), repository: new SqlitePartnerRegistryRepository(database) });
      await expect(service.pinForDispatch(first.partnerId)).rejects.toMatchObject({ code: "partner_not_available" });
      expect(database.transaction((connection) => connection.prepare("SELECT COUNT(*) AS count FROM partner_revisions WHERE partner_id = ?").get(first.partnerId)))
        .toEqual({ count: 3 });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
