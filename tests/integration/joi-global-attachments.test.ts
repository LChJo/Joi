import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { JoiInboxService } from "../../src/main/application/joi/joi-inbox-service.js";
import { JoiAttachmentService } from "../../src/main/infrastructure/artifacts/joi-attachment-service.js";
import { SqliteJoiInboxRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-inbox-repository.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

describe("global joi attachments", () => {
  it("stages before Workbench routing and atomically binds metadata to one durable input", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-global-attachment-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const clock = new TestClock();
      const ids = new TestIds();
      const attachments = new JoiAttachmentService({ clock, database, ids, rootDirectory: path.join(root, "artifacts") });
      const uploaded = await attachments.upload({ bytes: new TextEncoder().encode("attachment body"), filename: "brief.txt", mimeType: "text/plain" });
      const repository = new SqliteJoiInboxRepository(database);
      const inbox = new JoiInboxService({ clock, ids, repository });
      const accepted = await inbox.accept({ attachmentIds: [uploaded.attachmentId], idempotencyKey: "with-file", text: "review the attachment" });

      expect(JSON.stringify({ accepted, uploaded })).not.toContain(root);
      expect(database.transaction((connection) => connection.prepare(
        "SELECT input_id, attachment_id FROM joi_inbox_attachments",
      ).get())).toEqual({ attachment_id: uploaded.attachmentId, input_id: accepted.inputId });
      expect(await repository.loadInput(accepted.inputId)).toMatchObject({
        attachments: [{ attachmentId: uploaded.attachmentId, filename: "brief.txt", mimeType: "text/plain", size: 15 }],
      });
      await expect(inbox.accept({ attachmentIds: [uploaded.attachmentId], idempotencyKey: "reuse-file", text: "reuse" }))
        .rejects.toMatchObject({ code: "joi_attachment_already_bound" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reads stored attachment bytes back with verified integrity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-global-attachment-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const attachments = new JoiAttachmentService({ clock: new TestClock(), database, ids: new TestIds(), rootDirectory: path.join(root, "artifacts") });
      const uploaded = await attachments.upload({ bytes: new TextEncoder().encode("round trip body"), filename: "notes.md", mimeType: "text/markdown" });
      expect(await attachments.read(uploaded.attachmentId)).toEqual({
        bytes: new TextEncoder().encode("round trip body"),
        filename: "notes.md",
        mimeType: "text/markdown",
      });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects reads of missing attachments and tampered files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-global-attachment-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const attachments = new JoiAttachmentService({ clock: new TestClock(), database, ids: new TestIds(), rootDirectory: path.join(root, "artifacts") });
      await expect(attachments.read("joi_attachment_missing")).rejects.toMatchObject({ code: "joi_attachment_not_found" });
      const uploaded = await attachments.upload({ bytes: new TextEncoder().encode("guarded body"), filename: "brief.txt", mimeType: "text/plain" });
      await writeFile(path.join(root, "artifacts", "joi-attachments", `${uploaded.attachmentId}.bin`), "tampered body!");
      await expect(attachments.read(uploaded.attachmentId)).rejects.toMatchObject({ code: "joi_attachment_integrity_failed" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
