import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("imports a local image file by absolute path and rejects invalid import targets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-global-attachment-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const attachments = new JoiAttachmentService({ clock: new TestClock(), database, ids: new TestIds(), rootDirectory: path.join(root, "artifacts") });
      const imagePath = path.join(root, "captures", "terminal-paste.bmp");
      await mkdir(path.dirname(imagePath), { recursive: true });
      await writeFile(imagePath, new TextEncoder().encode("bmp payload"));

      const imported = await attachments.importPath({ path: imagePath });
      expect(imported).toMatchObject({ filename: "terminal-paste.bmp", mimeType: "image/bmp", size: 11 });
      expect(await attachments.read(imported.attachmentId)).toMatchObject({ filename: "terminal-paste.bmp" });

      await expect(attachments.importPath({ path: "captures/relative.bmp" })).rejects.toMatchObject({ code: "attachment_import_path_invalid" });
      await expect(attachments.importPath({ path: path.join(root, "notes.txt") })).rejects.toMatchObject({ code: "attachment_import_not_image" });
      await expect(attachments.importPath({ path: path.join(root, "missing.png") })).rejects.toMatchObject({ code: "attachment_import_not_found" });
      const directoryPng = path.join(root, "folder.png");
      await mkdir(directoryPng, { recursive: true });
      await expect(attachments.importPath({ path: directoryPng })).rejects.toMatchObject({ code: "attachment_import_not_found" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("transcodes bitmap uploads through the injected normalizer and keeps undecodable bytes as-is", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-global-attachment-"));
    const database = await openRuntimeDatabase({ databasePath: path.join(root, "runtime.sqlite"), migrationsDirectory: path.resolve("resources/migrations") });
    try {
      const oversizedBitmap = new Uint8Array(10 * 1024 * 1024 + 1);
      oversizedBitmap.set([0x42, 0x4d], 0);
      const attachments = new JoiAttachmentService({
        clock: new TestClock(),
        database,
        ids: new TestIds(),
        rootDirectory: path.join(root, "artifacts"),
        // Mirrors transcodeBitmapToPng: only decodes real bitmaps, keeps
        // everything else (including undecodable ones) untouched.
        transcodeBitmap: (input) => input.mimeType !== "image/bmp" || input.bytes[0] !== 0x42 || input.bytes[1] !== 0x4d
          ? undefined
          : { bytes: new TextEncoder().encode("png bytes"), filename: `${input.filename.replace(/\.bmp$/i, "")}.png`, mimeType: "image/png" },
      });
      const transcoded = await attachments.upload({ bytes: oversizedBitmap, filename: "clipboard.bmp", mimeType: "image/bmp" });
      expect(transcoded).toMatchObject({ filename: "clipboard.png", mimeType: "image/png", size: 9 });
      expect(await attachments.read(transcoded.attachmentId)).toEqual({
        bytes: new TextEncoder().encode("png bytes"),
        filename: "clipboard.png",
        mimeType: "image/png",
      });

      const undecodable = await attachments.upload({ bytes: new TextEncoder().encode("not a real bitmap"), filename: "broken.bmp", mimeType: "image/bmp" });
      expect(undecodable).toMatchObject({ filename: "broken.bmp", mimeType: "image/bmp" });
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
