import { DatabaseSync } from "node:sqlite";

import { applyMigrations } from "../../src/main/infrastructure/persistence/runtime-database.js";
import { SqliteJoiHomeFeedRepository } from "../../src/main/infrastructure/persistence/sqlite-joi-home-feed-repository.js";

const NOW = "2026-10-13T00:00:00.000Z";

describe("home feed historical query scale", () => {
  it("finds latest turns and distinct agents through goal-scoped lookups", async () => {
    const connection = new DatabaseSync(":memory:");
    try {
      await applyMigrations(connection, "resources/migrations");
      connection.exec("PRAGMA foreign_keys = OFF");
      connection.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,
        scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES ('scale-wb','Scale','persona','summary','scope','project','memory','ACTIVE',?,?)`).run(NOW, NOW);
      const inbox = connection.prepare(`INSERT INTO joi_inbox_messages
        (input_id,idempotency_key,body,status,workbench_id,goal_input_id,created_at,updated_at)
        VALUES (?,?, 'fixture goal','CONSUMED','scale-wb',?,?,?)`);
      const turn = connection.prepare(`INSERT INTO joi_turns
        (turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
        VALUES (?,?,'scale-wb','scale-session','COMPLETED',?,?)`);
      const work = connection.prepare(`INSERT INTO work_items
        (work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
        VALUES (?,'scale-wb',?,'fixture work','{}','READ','COMPLETED',?,?)`);
      const attempt = connection.prepare(`INSERT INTO dispatch_attempts
        (dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,
         instance_id,status,created_at,updated_at) VALUES (?,'plan',?,'rev',1,?,?,'COMPLETED',?,?)`);
      const session = connection.prepare(`INSERT INTO workbench_agent_sessions
        (agent_id,workbench_id,partner_id,partner_revision_id,backing_kind,backing_id,session_policy,created_at)
        VALUES (?,'scale-wb','partner','rev','LOCAL_INSTANCE',?,'EPHEMERAL',?)`);
      connection.exec("BEGIN");
      for (let i = 0; i < 820; i++) {
        inbox.run(`input-${String(i)}`, `key-${String(i)}`, i < 33 ? null : `input-${String(i % 33)}`, NOW, NOW);
      }
      for (let i = 0; i < 4_363; i++) turn.run(`turn-${String(i)}`, `input-${String(i % 820)}`, NOW, NOW);
      for (let i = 0; i < 847; i++) {
        work.run(`work-${String(i)}`, `input-${String(i % 33)}`, NOW, NOW);
        attempt.run(`attempt-${String(i)}`, `work-${String(i)}`, `action-${String(i)}`, `instance-${String(i)}`, NOW, NOW);
        if (i < 812) session.run(`agent-${String(i)}`, `instance-${String(i)}`, NOW);
      }
      connection.exec("COMMIT");
      let plan: string[] = [];
      const observed = new Proxy(connection, {
        get(target, property) {
          if (property === "prepare") return (sql: string) => {
            if (sql.includes("AS latest_turn_status") && sql.includes("AS agent_count")) {
              plan = target.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => String(row.detail));
            }
            return target.prepare(sql);
          };
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) as unknown : value;
        },
      });
      const repository = new SqliteJoiHomeFeedRepository({ transaction: (operation) => operation(observed) });
      const feed = await repository.load(new Date(NOW));
      expect(feed.goals).toHaveLength(33);
      expect(feed.goals.reduce((total, goal) => total + goal.agentCount, 0)).toBe(812);
      expect(plan).not.toContain("SCAN t");
      expect(plan.some((step) => /^SCAN (?:source|s)(?: |$)/u.test(step))).toBe(false);
    } finally {
      connection.close();
    }
  });
});
