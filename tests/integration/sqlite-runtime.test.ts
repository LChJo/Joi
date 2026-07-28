import path from "node:path";

import { LifeService } from "../../src/main/application/lives/life-service";
import { openRuntimeDatabase } from "../../src/main/infrastructure/persistence/runtime-database";
import { createRuntimeFixture, TestClock, TestIds } from "../support/runtime-fixture";

describe("SQLite runtime foundation", () => {
  it("enables safety pragmas, applies migrations, and restores Life plus SSE sequence", async () => {
    const fixture = await createRuntimeFixture();
    const databasePath = path.join(fixture.root, "runtime.sqlite");

    try {
      expect(fixture.database.inspect()).toMatchObject({
        busyTimeout: 5000,
        foreignKeys: true,
        journalMode: "wal",
        schemaVersion: 18,
      });
      const agent = await fixture.agents.createShell({ cardUrl: "http://192.168.1.20/agent-card.json", name: "主 Agent" });
      await fixture.agents.activateForReadiness(agent.agentConnectionId);
      const life = await fixture.lives.create({
        mainAgentConnectionId: agent.agentConnectionId,
        name: "栖遥",
        personaSummary: "一位关注长期连续性、会主动整理计划并诚实表达不确定性的数字生命。",
        principles: ["先保存事实，再采取行动"],
        timezone: "Asia/Shanghai",
      });
      expect(life.state).toBe("STOPPED");
      expect((await fixture.sse.listAfter(0, 10)).map((event) => event.type)).toContain("life.created");

      fixture.database.close();
      const reopened = await openRuntimeDatabase({
        databasePath,
        migrationsDirectory: path.resolve("resources/migrations"),
      });
      const service = new LifeService({
        clock: new TestClock(),
        ids: new TestIds(),
        publisher: { publish: vi.fn() },
        store: reopened.store,
      });

      expect((await service.list({ limit: 20 })).items).toEqual([
        expect.objectContaining({ lifeId: life.lifeId, name: "栖遥" }),
      ]);
      const events = await reopened.store.listSseEvents(0, 10);
      expect(events.at(-1)?.sequence).toBeGreaterThan(0);
      reopened.close();
    } finally {
      await fixture.close();
    }
  });

  it("rolls back all writes when a transaction fails", async () => {
    const fixture = await createRuntimeFixture();
    try {
      expect(() => fixture.database.transaction((database) => {
        database.prepare(
          "INSERT INTO outbox (outbox_id, kind, payload_json, status, attempt_count, available_at, created_at) VALUES (?, ?, ?, 'PENDING', 0, ?, ?)",
        ).run("outbox_rollback", "test", "{}", "2026-07-15T12:00:00.000Z", "2026-07-15T12:00:00.000Z");
        throw new Error("force rollback");
      })).toThrow("force rollback");

      expect(await fixture.database.store.countOutbox()).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
