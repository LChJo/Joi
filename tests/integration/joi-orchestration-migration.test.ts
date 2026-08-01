import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AgentService } from "../../src/main/application/agents/agent-service.js";
import { LifeService } from "../../src/main/application/lives/life-service.js";
import { AvatarRegistryService } from "../../src/main/application/joi/avatar-registry-service.js";
import { SseService } from "../../src/main/application/sse/sse-service.js";
import { InMemorySseBroker } from "../../src/main/infrastructure/http/in-memory-sse-broker.js";
import { LegacyLifeStoreAdapter } from "../../src/main/infrastructure/persistence/legacy-life-store-adapter.js";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { TestClock, TestIds } from "../support/runtime-fixture.js";

async function copyMigrationsThrough(destination: string, maximumVersion: number): Promise<void> {
  await mkdir(destination, { recursive: true });
  const source = path.resolve("resources/migrations");
  for (const filename of await readdir(source)) {
    const version = Number.parseInt(filename.split("_", 1)[0] ?? "", 10);
    if (Number.isSafeInteger(version) && version <= maximumVersion) await copyFile(path.join(source, filename), path.join(destination, filename));
  }
}

describe("JOI-01 non-destructive migration", () => {
  it("creates the new orchestration schema on an empty database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-schema-empty-"));
    const database = await openRuntimeDatabase({
      databasePath: path.join(root, "runtime.sqlite"),
      migrationsDirectory: path.resolve("resources/migrations"),
    });
    try {
      expect(database.inspect().schemaVersion).toBe(22);
      expect(database.transaction((connection) => connection.prepare("PRAGMA table_info(model_source_revisions)").all()))
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "access_mode" }), expect.objectContaining({ name: "protocol" })]));
      const names = database.transaction((connection) => connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all().map((row) => String((row as { name: unknown }).name)));
      expect(names).toEqual(expect.arrayContaining([
        "avatars",
        "avatar_change_requests",
        "avatar_merges",
        "model_sources",
        "model_source_credentials",
        "model_source_revisions",
        "model_source_model_revisions",
        "model_source_health",
        "partners",
        "partner_revisions",
        "partner_prompts",
        "partner_runs",
        "partner_result_events",
        "avatar_partner_policies",
        "joi_inbox_messages",
        "joi_attachments",
        "joi_inbox_attachments",
        "joi_turns",
        "joi_session_messages",
        "work_items",
        "work_dependencies",
        "dispatch_attempts",
        "workspace_leases",
      ]));
    } finally {
      database.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("backfills legacy identities without changing old counts and maps the primary Agent to preferred Partner", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-schema-upgrade-"));
    const legacyMigrations = path.join(root, "legacy-migrations");
    await copyMigrationsThrough(legacyMigrations, 16);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: legacyMigrations });
    const clock = new TestClock();
    const ids = new TestIds();
    const sse = new SseService({ broker: new InMemorySseBroker(), clock, store: oldDatabase.store });
    const agents = new AgentService({ clock, ids, store: oldDatabase.store });
    const lives = new LifeService({ clock, ids, publisher: sse, store: oldDatabase.store });
    const agent = await agents.createShell({ cardUrl: "http://192.168.1.20/card.json", name: "旧主 Agent" });
    await agents.activateForReadiness(agent.agentConnectionId);
    const legacy = await lives.create({
      mainAgentConnectionId: agent.agentConnectionId,
      name: "产品工作",
      personaSummary: "保留全部旧上下文",
      timezone: "Asia/Shanghai",
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      expect(upgraded.inspect().schemaVersion).toBe(22);
      const counts = upgraded.transaction((connection) => ({
        agents: (connection.prepare("SELECT COUNT(*) AS count FROM agent_connections").get() as { count: number }).count,
        avatars: (connection.prepare("SELECT COUNT(*) AS count FROM avatars").get() as { count: number }).count,
        lives: (connection.prepare("SELECT COUNT(*) AS count FROM lives").get() as { count: number }).count,
        partners: (connection.prepare("SELECT COUNT(*) AS count FROM partners").get() as { count: number }).count,
      }));
      expect(counts).toEqual({ agents: 1, avatars: 1, lives: 1, partners: 1 });

      const mapping = upgraded.transaction((connection) => connection.prepare(`
        SELECT a.avatar_id, a.legacy_life_id, p.preferred_partner_id
          FROM avatars a JOIN avatar_partner_policies p ON p.avatar_id = a.avatar_id
         WHERE a.avatar_id = ?`).get(legacy.lifeId)) as { avatar_id: string; legacy_life_id: string; preferred_partner_id: string };
      expect(mapping).toEqual({
        avatar_id: legacy.lifeId,
        legacy_life_id: legacy.lifeId,
        preferred_partner_id: `partner_${agent.agentConnectionId}`,
      });

      const adapter = new LegacyLifeStoreAdapter(upgraded);
      expect(await adapter.getAvatar(legacy.lifeId)).toMatchObject({
        avatarId: legacy.lifeId,
        profile: { name: "产品工作", personaSummary: "保留全部旧上下文" },
      });
      expect(await adapter.getPreferredPartnerId(legacy.lifeId)).toBe(`partner_${agent.agentConnectionId}`);

      const upgradedSse = new SseService({ broker: new InMemorySseBroker(), clock, store: upgraded.store });
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      ).all())).toEqual(expect.arrayContaining([{ name: "mirror_new_life_as_avatar" }]));
      const compatibilityLives = new LifeService({ clock, ids, publisher: upgradedSse, store: upgraded.store });
      const mirrored = await compatibilityLives.create({
        mainAgentConnectionId: agent.agentConnectionId,
        name: "兼容创建",
        personaSummary: "旧 API 仍会镜像 Avatar",
        timezone: "Asia/Shanghai",
      });
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT avatar_id, status FROM avatars WHERE avatar_id = ?",
      ).get(mirrored.lifeId))).toEqual({ avatar_id: mirrored.lifeId, status: "ACTIVE" });
      expect(await adapter.getAvatar(mirrored.lifeId)).toMatchObject({ profile: { name: "兼容创建" } });

      const registry = new AvatarRegistryService({ clock, ids, repository: adapter });
      const nativeAvatar = await registry.create({
        name: "原生 Avatar",
        personaSummary: "由唯一 joi 创建",
        projectLabel: "新工程",
        scopeSummary: "新的隔离范围",
      });
      expect(await adapter.getAvatar(nativeAvatar.avatarId)).toMatchObject({
        profile: { name: "原生 Avatar", scopeSummary: "新的隔离范围" },
        project: { label: "新工程" },
      });
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("backfills existing source protocols without changing credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "joi-schema-protocol-"));
    const oldMigrations = path.join(root, "old-migrations");
    await copyMigrationsThrough(oldMigrations, 21);
    const databasePath = path.join(root, "runtime.sqlite");
    const oldDatabase = await openRuntimeDatabase({ databasePath, migrationsDirectory: oldMigrations });
    const now = "2026-07-30T10:00:00.000Z";
    oldDatabase.transaction((connection) => {
      connection.prepare(`INSERT INTO model_source_credentials
        (provider_id, credential_type, encrypted_blob, credential_version, updated_at)
        VALUES ('joi-source:kimi-old', 'api_key', ?, 1, ?)`)
        .run(new Uint8Array([7, 8, 9]), now);
      connection.prepare(`INSERT INTO model_sources
        (source_id, status, active_source_revision_id, active_model_revision_id, created_at, updated_at)
        VALUES ('kimi-old', 'DRAFT', NULL, NULL, ?, ?)`)
        .run(now, now);
      connection.prepare(`INSERT INTO model_source_revisions
        (source_revision_id, source_id, kind, access_mode, display_name, credential_ref, credential_version, created_at)
        VALUES ('revision-kimi-old', 'kimi-old', 'kimi', 'coding-plan', 'Kimi Code', 'joi-source:kimi-old', 1, ?)`)
        .run(now);
    });
    oldDatabase.close();

    const upgraded = await openRuntimeDatabase({ databasePath, migrationsDirectory: path.resolve("resources/migrations") });
    try {
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT protocol FROM model_source_revisions WHERE source_revision_id = 'revision-kimi-old'",
      ).get())).toEqual({ protocol: "anthropic" });
      expect(upgraded.transaction((connection) => connection.prepare(
        "SELECT length(encrypted_blob) AS size FROM model_source_credentials WHERE provider_id = 'joi-source:kimi-old'",
      ).get())).toEqual({ size: 3 });
    } finally {
      upgraded.close();
      await rm(root, { force: true, recursive: true });
    }
  });
});
