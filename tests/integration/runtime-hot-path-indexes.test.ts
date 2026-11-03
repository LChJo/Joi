import type { DatabaseSync } from "node:sqlite";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { SqliteWorkbenchAgentScan } from "../../src/main/infrastructure/persistence/sqlite-workbench-agent-scan";
import { SqlitePartnerDispatchClaims } from "../../src/main/infrastructure/a2a/partner-dispatch-delivery-adapter";
import { createRuntimeFixture, type RuntimeFixture } from "../support/runtime-fixture";

describe("runtime activity query access paths", () => {
  let fixture: RuntimeFixture;
  const queries: string[] = [];
  beforeEach(async () => { fixture = await createRuntimeFixture(); queries.length = 0; });
  afterEach(async () => fixture.close());
  const observed = {
    transaction<T>(operation: (db: DatabaseSync) => T): T {
      return fixture.database.transaction(db => operation(new Proxy(db, {
        get(target, property, receiver) {
          if (property === "prepare") return (sql: string) => { queries.push(sql); return target.prepare(sql); };
          return Reflect.get(target, property, receiver) as unknown;
        },
      })));
    },
  };
  function plan(sql: string): string[] {
    return fixture.database.transaction(db => db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...Array.from({ length: sql.match(/\?/gu)?.length ?? 0 }, () => "fixture"))
      .map(row => String(row.detail)));
  }
  it("checks foreground activity through partial active indexes", () => {
    expect(new SqliteEvolutionStore(observed).idle()).toBe(true);
    const steps = plan(queries[0] ?? "").join("\n");
    expect(steps).toContain("idx_joi_turns_running");
    expect(steps).toContain("idx_work_items_foreground");
    expect(steps).not.toMatch(/SCAN w\n/u);
  });
  it("discovers actors from nonterminal attempts, runs and live instances", async () => {
    expect(await new SqliteWorkbenchAgentScan(observed).listPartnerKeys("bench")).toEqual([]);
    const steps = plan(queries[0] ?? "");
    expect(steps.join("\n")).toContain("idx_dispatch_attempts_active");
    expect(steps.join("\n")).toContain("idx_partner_instances_live");
    expect(steps.join("\n")).toContain("idx_partner_runs_active");
    expect(steps.findIndex(step => step.includes("idx_dispatch_attempts_active")))
      .toBeLessThan(steps.findIndex(step => /SEARCH w\b/u.test(step)));
  });
  it("drives dispatch claims from the due outbox and reverse attempt index", async () => {
    expect(await new SqlitePartnerDispatchClaims(observed).listClaimable({ workbenchId: "bench", partnerId: "partner", now: "2026-11-03T00:00:00Z" })).toEqual([]);
    const steps = plan(queries[0] ?? "");
    expect(steps.join("\n")).toContain("idx_outbox_kind_ready");
    expect(steps.join("\n")).toContain("idx_dispatch_attempts_outbox");
    expect(steps.join("\n")).not.toContain("idx_work_items_workbench_status");
  });
  async function dispatchFixture() {
    const partner = await fixture.partners.add({ capabilities: [], displayName: "Fixture", kind: "local-pi", skills: [], tools: [] });
    const other = await fixture.partners.add({ capabilities: [], displayName: "Other", kind: "local-pi", skills: [], tools: [] });
    const now = "2026-11-03T01:00:00.000Z";
    fixture.database.transaction(db => db.exec(`
      INSERT INTO workbenches(workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at)
        VALUES ('bench','Fixture','p','','','','m','ACTIVE','${now}','${now}');
      INSERT INTO joi_inbox_messages(input_id,idempotency_key,body,status,workbench_id,created_at,updated_at)
        VALUES ('goal','goal','fixture','CONSUMED','bench','${now}','${now}');
      INSERT INTO joi_turns(turn_id,input_id,workbench_id,session_id,status,created_at,updated_at)
        VALUES ('turn','goal','bench','session','COMPLETED','${now}','${now}');
      INSERT INTO dispatch_plans(dispatch_plan_id,turn_id,candidate_json,policy_result_json,created_at)
        VALUES ('plan','turn','{}','{}','${now}');
    `));
    function seed(id: string, revisionId = partner.partnerRevisionId, options: { workStatus?: string; outboxStatus?: string; availableAt?: string; claimUntil?: string } = {}) {
      fixture.database.transaction(db => {
        db.prepare(`INSERT INTO work_items(work_id,workbench_id,input_id,title,intent_json,access_mode,status,created_at,updated_at)
          VALUES (?,'bench','goal','fixture','{}','READ',?,?,?)`).run(id, options.workStatus ?? "READY", now, now);
        db.prepare(`INSERT INTO outbox(outbox_id,kind,payload_json,status,attempt_count,available_at,claim_until,created_at)
          VALUES (?,'partner.dispatch','{}',?,0,?,?,?)`).run(`out:${id}`, options.outboxStatus ?? "PENDING", options.availableAt ?? now, options.claimUntil ?? null, now);
        db.prepare(`INSERT INTO dispatch_attempts(dispatch_attempt_id,dispatch_plan_id,work_id,partner_revision_id,registry_revision,action_id,outbox_id,status,created_at,updated_at)
          VALUES (?,'plan',?,?,1,?,?,'PENDING',?,?)`).run(`attempt:${id}`, id, revisionId, `action:${id}`, `out:${id}`, now, now);
      });
    }
    const claim = () => new SqlitePartnerDispatchClaims(fixture.database).listClaimable({ workbenchId: "bench", partnerId: partner.partnerId, now });
    return { partner, other, now, seed, claim };
  }
  it("applies the candidate limit after partner and dependency filters", async () => {
    const { other, seed, claim } = await dispatchFixture();
    for (let i = 0; i < 12; i += 1) seed(`a-other-${String(i).padStart(2, "0")}`, other.partnerRevisionId);
    seed("b-dependency", undefined, { workStatus: "WAITING" });
    seed("c-blocked");
    fixture.database.transaction(db => db.prepare("INSERT INTO work_dependencies(work_id,depends_on_work_id) VALUES ('c-blocked','b-dependency')").run());
    for (let i = 0; i < 12; i += 1) seed(`d-eligible-${String(i).padStart(2, "0")}`);
    expect((await claim()).map(row => row.outboxId)).toEqual(Array.from({ length: 10 }, (_, i) => `out:d-eligible-${String(i).padStart(2, "0")}`));
    fixture.database.transaction(db => db.prepare("UPDATE work_items SET status='COMPLETED' WHERE work_id='b-dependency'").run());
    expect((await claim())[0]?.outboxId).toBe("out:c-blocked");
  });
  it("reconsiders availability and expired claims without a database write", async () => {
    const { partner, now, seed, claim } = await dispatchFixture();
    seed("future", undefined, { availableAt: "2026-11-03T01:00:02.000Z" });
    seed("leased", undefined, { outboxStatus: "CLAIMED", claimUntil: "2026-11-03T01:00:02.000Z" });
    seed("expired", undefined, { outboxStatus: "CLAIMED", claimUntil: now });
    expect((await claim()).map(row => row.outboxId)).toEqual(["out:expired"]);
    expect((await new SqlitePartnerDispatchClaims(fixture.database).listClaimable({ workbenchId: "bench", partnerId: partner.partnerId, now: "2026-11-03T01:00:02.000Z" })).map(row => row.outboxId))
      .toEqual(["out:expired", "out:future", "out:leased"]);
  });
  it("retains running and canceled re-ack candidates behind a closed goal gate", async () => {
    const { partner, now, seed, claim } = await dispatchFixture();
    seed("ready");
    for (const status of ["RUNNING", "CANCELED"]) {
      seed(status, undefined, { workStatus: status });
      fixture.database.transaction(db => db.prepare(`INSERT INTO partner_runs(run_id,dispatch_attempt_id,action_id,workbench_id,work_id,partner_revision_id,kind,external_run_id,status,created_at,updated_at)
        VALUES (?,?,?,'bench',?,?,'LOCAL_PI',?,'RUNNING',?,?)`).run(`run:${status}`, `attempt:${status}`, `action:${status}`, status, partner.partnerRevisionId, status, now, now));
    }
    fixture.database.transaction(db => db.prepare(`INSERT INTO joi_goal_execution_gates
      (goal_input_id,question_id,question_version,status,reason_code,created_at,updated_at)
      VALUES ('goal','question',1,'WAITING_INPUT','fixture',?,?)`).run(now, now));
    expect((await claim()).map(row => row.dispatchAttemptId)).toEqual(["attempt:CANCELED", "attempt:RUNNING"]);
  });
});
