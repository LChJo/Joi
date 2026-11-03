import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";
import { openRuntimeDatabaseFixture } from "../support/runtime-database-fixture.js";

describe("joi-message-durable-before-reasoning", () => {
  it("accepts idempotently and restores pending input metadata after restart without exposing the full body", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-inbox-"));
    const databasePath = path.join(root, "runtime.sqlite");
    const secret = `only-stored-in-the-inbox-${"x".repeat(120)}`;
    let database = await openRuntimeDatabaseFixture(databasePath);
    try {
      let service = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository: new SqliteJoiInboxRepository(database) });
      await expect(service.accept({ idempotencyKey: "", text: "valid" })).rejects.toMatchObject({ code: "idempotency_key_invalid" });
      await expect(service.accept({ idempotencyKey: "valid", text: "   " })).rejects.toMatchObject({ code: "joi_message_invalid" });
      const accepted = await service.accept({ idempotencyKey: "input-key-1", text: secret });
      expect(accepted.textPreview).toBe(`${secret.slice(0, 80)}…`);
      expect(await service.accept({ idempotencyKey: "input-key-1", text: "must not replace original" })).toEqual(accepted);
      database.close();

      database = await openRuntimeDatabaseFixture(databasePath);
      service = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository: new SqliteJoiInboxRepository(database) });
      const pending = await service.list();
      expect(pending).toEqual([accepted]);
      expect(JSON.stringify(pending)).not.toContain(secret);
      expect(database.transaction((connection) => connection.prepare("SELECT body FROM joi_inbox_messages WHERE input_id = ?").get(accepted.inputId)))
        .toEqual({ body: secret });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
