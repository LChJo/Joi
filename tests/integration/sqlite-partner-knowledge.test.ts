import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PartnerKnowledgeService } from "../../src/main/application/partners/partner-knowledge-service.js";
import { PartnerRegistryService } from "../../src/main/application/partners/partner-registry-service.js";
import { SqlitePartnerKnowledgeStore } from "../../src/main/infrastructure/persistence/sqlite-partner-knowledge-store.js";
import { SqlitePartnerRegistryRepository } from "../../src/main/infrastructure/persistence/sqlite-partner-registry-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("SQLite partner knowledge store", () => {
  it("persists knowledge docs, copies them between partners and survives restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-knowledge-"));
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const ids = new TestIds();
      let partners = new PartnerRegistryService({ clock: new TestClock(), ids, repository: new SqlitePartnerRegistryRepository(database) });
      const partner = await partners.add({ capabilities: [], displayName: "Local", kind: "local-pi", skills: [], tools: [], workspaceRef: "workspace" });
      let store = new SqlitePartnerKnowledgeStore(database);
      let knowledge = new PartnerKnowledgeService({ clock: new TestClock(), ids, store });

      const first = await knowledge.add({ body: "# 规范\n先读后写。", filename: "guide.md", partnerId: partner.partnerId });
      const second = await knowledge.add({ body: "checklist", filename: "checklist.md", partnerId: partner.partnerId });
      expect(await knowledge.count(partner.partnerId)).toBe(2);
      expect((await knowledge.list(partner.partnerId)).map((doc) => doc.filename)).toEqual(["guide.md", "checklist.md"]);
      const injection = await knowledge.readForInjection(partner.partnerId);
      expect(injection).toContain("[knowledge: guide.md]");
      expect(injection).toContain("先读后写。");

      database.close();
      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      partners = new PartnerRegistryService({ clock: new TestClock(), ids, repository: new SqlitePartnerRegistryRepository(database) });
      store = new SqlitePartnerKnowledgeStore(database);
      knowledge = new PartnerKnowledgeService({ clock: new TestClock(), ids, store });
      expect(await knowledge.count(partner.partnerId)).toBe(2);
      expect((await store.readBodies(partner.partnerId)).map((doc) => doc.filename)).toEqual(["guide.md", "checklist.md"]);

      const copyTarget = await partners.add({ capabilities: [], displayName: "Copy", kind: "local-pi", skills: [], tools: [] });
      expect(await knowledge.duplicateTo(partner.partnerId, copyTarget.partnerId)).toBe(2);
      const copied = await knowledge.list(copyTarget.partnerId);
      expect(copied.map((doc) => doc.filename)).toEqual(["guide.md", "checklist.md"]);
      expect(copied.map((doc) => doc.docId)).not.toContain(first.docId);
      expect(copied.map((doc) => doc.docId)).not.toContain(second.docId);

      expect(await knowledge.remove(partner.partnerId, first.docId)).toBe(true);
      expect(await knowledge.count(partner.partnerId)).toBe(1);
      expect(await knowledge.count(copyTarget.partnerId)).toBe(2);
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("round-trips the new partner config columns through revisions and restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-partner-config-"));
    const databasePath = path.join(root, "runtime.sqlite");
    let database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const ids = new TestIds();
      let repository = new SqlitePartnerRegistryRepository(database);
      let service = new PartnerRegistryService({ clock: new TestClock(), ids, repository });
      const created = await service.add({
        capabilities: ["code"], description: "工程搭档", displayName: "Coder", engine: "pi-core",
        kind: "local-pi", modelIdOverride: "kimi-k2.5", skills: [], tools: ["read"], workspaceRef: "workspace",
      });
      expect(created).toMatchObject({ createdBy: "user", description: "工程搭档", engine: "pi-core", modelIdOverride: "kimi-k2.5" });

      database.close();
      database = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
      repository = new SqlitePartnerRegistryRepository(database);
      service = new PartnerRegistryService({ clock: new TestClock(), ids, repository });
      const restored = await repository.getActive(created.partnerId);
      expect(restored).toMatchObject({ createdBy: "user", description: "工程搭档", engine: "pi-core", modelIdOverride: "kimi-k2.5" });
      const duplicated = await service.duplicate(created.partnerId);
      expect(duplicated).toMatchObject({ createdBy: "user", description: "工程搭档", displayName: "Coder（副本）", modelIdOverride: "kimi-k2.5" });
      expect((await repository.getActive(duplicated.partnerId))?.createdBy).toBe("user");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
