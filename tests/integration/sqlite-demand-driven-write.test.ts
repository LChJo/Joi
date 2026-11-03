import { DatabaseSync } from "node:sqlite";
import { SqliteWorkspaceLeaseManager } from "../../src/main/infrastructure/persistence/sqlite-workspace-lease-manager.js";
import { TestClock } from "../support/runtime-fixture.js";

describe("AC-WR-01/02 transactional write queue", () => {
  function fixture() {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE workbench_workspace_roots (workspace_ref TEXT PRIMARY KEY, root_path TEXT NOT NULL);
      CREATE TABLE work_run_directories (work_id TEXT PRIMARY KEY, root_path TEXT NOT NULL);
      CREATE TABLE workspace_leases (workspace_ref TEXT, work_id TEXT, access_mode TEXT, lease_owner TEXT,
        generation INTEGER, expires_at TEXT, root_key TEXT, PRIMARY KEY (workspace_ref, work_id));
      CREATE TABLE workspace_write_waiters (sequence INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT UNIQUE,
        workspace_ref TEXT, root_key TEXT, generation INTEGER);
      INSERT INTO workbench_workspace_roots VALUES ('a','C:/shared/project'),('b','c:/shared/project/');`);
    return { db, leases: new SqliteWorkspaceLeaseManager({ clock: new TestClock(), database: { transaction: op => op(db) } }) };
  }
  it("releases both upgrading readers without deadlock, honors FIFO and stops new readers", async () => {
    const { db, leases } = fixture();
    try {
      await leases.acquire({ accessMode: "READ", workId: "one", workspaceRef: "a" });
      await leases.acquire({ accessMode: "READ", workId: "two", workspaceRef: "b" });
      expect(await leases.requestWrite({ workId: "one", workspaceRef: "a", generation: 1 })).toBeNull();
      expect(db.prepare("SELECT 1 FROM workspace_leases WHERE work_id = 'one'").get()).toBeUndefined();
      expect(await leases.acquire({ accessMode: "READ", workId: "late", workspaceRef: "a" })).toBeNull();
      expect(await leases.requestWrite({ workId: "two", workspaceRef: "b", generation: 1 })).toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM workspace_leases").get()?.n).toBe(0);
      expect(await leases.acquire({ accessMode: "WRITE", workId: "two", workspaceRef: "b" })).toBeNull();
      expect(await leases.acquire({ accessMode: "WRITE", workId: "one", workspaceRef: "a" })).toMatchObject({ accessMode: "WRITE" });
      expect(await leases.acquire({ accessMode: "READ", workId: "late", workspaceRef: "b" })).toBeNull();
      await leases.release("one");
      expect(await leases.acquire({ accessMode: "WRITE", workId: "two", workspaceRef: "b" })).toMatchObject({ accessMode: "WRITE" });
    } finally { db.close(); }
  });
  it("upgrades the sole reader atomically and ignores obsolete releases", async () => {
    const { db, leases } = fixture();
    try {
      const read = await leases.acquire({ accessMode: "READ", workId: "one", workspaceRef: "a" });
      const write = await leases.requestWrite({ workId: "one", workspaceRef: "a", generation: 1 });
      if (write === null) throw new Error("missing_write_lease");
      expect(write).toMatchObject({ accessMode: "WRITE", generation: 2 });
      await leases.release("one", read?.generation);
      expect(await leases.renew({ workId: "one", workspaceRef: "a", generation: write.generation })).toMatchObject({ accessMode: "WRITE" });
    } finally { db.close(); }
  });
});
