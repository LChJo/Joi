import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("sqlite joi inbox cancel", () => {
  it("cancels a clarification input and refuses rows that already left the queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-cancel-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-1", text: "研究登录改造" });

      expect(await repository.cancel("does-not-exist")).toBeNull();
      const canceledRecord = await repository.cancel(accepted.inputId);
      expect(canceledRecord).toMatchObject({ inputId: accepted.inputId, status: "CONSUMED" });
      expect(typeof canceledRecord?.canceledAt).toBe("string");
      expect(await repository.cancel(accepted.inputId)).toBeNull();

      await repository.requireClarification(accepted.inputId, "avatar_selection_invalid");
      expect((await repository.loadInput(accepted.inputId))?.status).toBe("CONSUMED");
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cancels a pending input and the service rejects a non-cancelable one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-cancel-pending-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock: new TestClock(), ids: new TestIds(), repository });
      const accepted = await inbox.accept({ idempotencyKey: "key-2", text: "归属？" });
      const canceled = await inbox.cancel({ inputId: accepted.inputId });
      expect(canceled).toMatchObject({ canceled: true, status: "CONSUMED" });
      await expect(inbox.cancel({ inputId: accepted.inputId })).rejects.toMatchObject({ code: "joi_cancel_unavailable" });
      expect(await repository.clarify(accepted.inputId, { text: "too late" })).toBeNull();
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
