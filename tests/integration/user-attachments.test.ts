import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { EventService } from "../../src/main/application/events/event-service";
import { LifeFileDeletionService } from "../../src/main/infrastructure/artifacts/life-file-deletion-service";
import { LifeService } from "../../src/main/application/lives/life-service";
import { InMemoryEventSignal } from "../../src/main/infrastructure/runtime/in-memory-event-signal";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

const card = {
  authentication: "bearer" as const,
  capabilities: { streaming: true },
  cardHash: "a".repeat(64),
  cardUrl: "http://agent.lan/card.json",
  cardUrlHash: "b".repeat(64),
  description: "Agent",
  name: "Agent",
  origin: "http://agent.lan",
  protocolVersion: "0.3.0",
  rpcUrl: "http://agent.lan/rpc",
  skills: ["planning"],
  transport: "JSONRPC" as const,
};

// Mirrors the row shape the retired AttachmentService.upload produced, so the
// EventService/LifeFileDeletionService validation paths stay fully exercised.
async function seedAttachment(fixture: RuntimeFixture, input: { bytes: Uint8Array; filename: string; lifeId: string; mimeType: string }) {
  const attachmentId = fixture.ids.next("attachment");
  const relativePath = path.join("user-attachments", `${attachmentId}.bin`);
  fixture.database.transaction((database) => database.prepare(`
    INSERT INTO user_attachments
      (attachment_id, life_id, event_id, filename, mime_type, size_bytes, relative_path, sha256, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
    .run(attachmentId, input.lifeId, input.filename, input.mimeType, input.bytes.byteLength, relativePath,
      createHash("sha256").update(input.bytes).digest("hex"), fixture.clock.now().toISOString()));
  const target = path.join(fixture.root, "artifacts", relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, input.bytes);
  return { attachmentId, relativePath };
}

describe("managed user attachments", () => {
  it("atomically scopes attachments to one message and binds them to the ingested event", async () => {
    const fixture = await createRuntimeFixture();
    await fixture.database.store.saveOnboardedAgent({
      agentConnectionId: "agent_attachment", card, cardSnapshotId: "card_attachment", credentialId: "credential_attachment",
      credentialVersion: 1, encryptedCredential: new Uint8Array([1]), now: fixture.clock.now().toISOString(), readiness: true, status: "ACTIVE",
    });
    const life = await fixture.lives.create({
      mainAgentConnectionId: "agent_attachment", name: "附件生命", personaSummary: "显式处理文件", timezone: "UTC",
    });
    const otherLife = await fixture.lives.create({
      mainAgentConnectionId: "agent_attachment", name: "隔离生命", personaSummary: "不能越权读取", timezone: "UTC",
    });
    const events = new EventService({
      clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal: new InMemoryEventSignal(), store: fixture.database.store,
    });
    try {
      const seeded = await seedAttachment(fixture, {
        bytes: new TextEncoder().encode("hello attachment"), filename: "brief.txt", lifeId: life.lifeId, mimeType: "text/plain",
      });
      await expect(events.ingest({
        attachmentIds: [seeded.attachmentId], lifeId: otherLife.lifeId, payload: { text: "越权" }, source: "human", type: "human.message",
      })).rejects.toMatchObject({ code: "attachment_not_found" });

      const event = await events.ingest({
        attachmentIds: [seeded.attachmentId], lifeId: life.lifeId, payload: { text: "请阅读" }, source: "human", type: "human.message",
      });
      expect(event.payload).toMatchObject({
        attachments: [{ attachmentId: seeded.attachmentId, filename: "brief.txt", mimeType: "text/plain", size: 16 }], text: "请阅读",
      });
      await expect(events.ingest({
        attachmentIds: [seeded.attachmentId], lifeId: life.lifeId, payload: { text: "重复使用" }, source: "human", type: "human.message",
      })).rejects.toMatchObject({ code: "attachment_already_used" });

      const stored = await fixture.database.store.getUserAttachment(seeded.attachmentId);
      expect(stored).toMatchObject({ eventId: event.eventId, lifeId: life.lifeId });
    } finally {
      await fixture.close();
    }
  });

  it("shows managed file impact and stages files transactionally during Life deletion", async () => {
    const fixture = await createRuntimeFixture();
    await fixture.database.store.saveOnboardedAgent({
      agentConnectionId: "agent_delete_files", card, cardSnapshotId: "card_delete_files", credentialId: "credential_delete_files",
      credentialVersion: 1, encryptedCredential: new Uint8Array([1]), now: fixture.clock.now().toISOString(), readiness: true, status: "ACTIVE",
    });
    const life = await fixture.lives.create({
      mainAgentConnectionId: "agent_delete_files", name: "待删除生命", personaSummary: "验证文件清理", timezone: "UTC",
    });
    const rootDirectory = path.join(fixture.root, "artifacts");
    const events = new EventService({
      clock: fixture.clock, ids: fixture.ids, publisher: fixture.sse, signal: new InMemoryEventSignal(), store: fixture.database.store,
    });
    const files = new LifeFileDeletionService({ ids: fixture.ids, rootDirectory, store: fixture.database.store });
    try {
      const seeded = await seedAttachment(fixture, {
        bytes: new TextEncoder().encode("delete me"), filename: "delete.txt", lifeId: life.lifeId, mimeType: "text/plain",
      });
      await events.ingest({ attachmentIds: [seeded.attachmentId], lifeId: life.lifeId, payload: { text: "保存" }, source: "human", type: "human.message" });
      const record = await fixture.database.store.getUserAttachment(seeded.attachmentId);
      if (record === null) throw new Error("attachment missing");
      const filePath = path.join(rootDirectory, record.relativePath);
      expect(await fixture.lives.getDeletionImpact(life.lifeId)).toMatchObject({ attachments: 1, managedBytes: 9 });

      const staged = await files.stage(life.lifeId);
      await expect(access(filePath)).rejects.toBeDefined();
      await files.rollback(staged);
      await expect(access(filePath)).resolves.toBeUndefined();

      const deletingLives = new LifeService({ clock: fixture.clock, files, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store });
      await deletingLives.delete(life.lifeId);
      await expect(access(filePath)).rejects.toBeDefined();
      expect(await fixture.database.store.getUserAttachment(seeded.attachmentId)).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("deletes a Life cleanly before managed storage has ever been created", async () => {
    const fixture = await createRuntimeFixture();
    await fixture.database.store.saveOnboardedAgent({
      agentConnectionId: "agent_delete_empty", card, cardSnapshotId: "card_delete_empty", credentialId: "credential_delete_empty",
      credentialVersion: 1, encryptedCredential: new Uint8Array([1]), now: fixture.clock.now().toISOString(), readiness: true, status: "ACTIVE",
    });
    const life = await fixture.lives.create({
      mainAgentConnectionId: "agent_delete_empty", name: "空文件生命", personaSummary: "首次删除也应成功", timezone: "UTC",
    });
    const rootDirectory = path.join(fixture.root, "never-created-artifacts");
    const files = new LifeFileDeletionService({ ids: fixture.ids, rootDirectory, store: fixture.database.store });
    const deletingLives = new LifeService({ clock: fixture.clock, files, ids: fixture.ids, publisher: fixture.sse, store: fixture.database.store });
    try {
      await expect(deletingLives.delete(life.lifeId)).resolves.toBeUndefined();
      await expect(access(rootDirectory)).resolves.toBeUndefined();
    } finally {
      await fixture.close();
    }
  });
});
