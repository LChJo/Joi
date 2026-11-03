import { EvolutionDryRun } from "../../src/main/application/evolution/evolution-dry-run";
import { SqliteEvolutionStore } from "../../src/main/infrastructure/persistence/sqlite-evolution-store";
import { createRuntimeFixture } from "../support/runtime-fixture";

it("completes a batch without writing anything to the runtime database", async () => {
  const fixture = await createRuntimeFixture();
  try {
    fixture.database.transaction((db) => db.prepare(`INSERT INTO workbenches (workbench_id,name,persona_revision_id,persona_summary,scope_summary,project_label,memory_namespace_id,status,created_at,updated_at) VALUES ('a','A','p','persona','','','m','ACTIVE','2026-09-22','2026-09-22')`).run());
    const store = new SqliteEvolutionStore(fixture.database);
    const counts = () => fixture.database.transaction((db) => db.prepare(`SELECT
      (SELECT COUNT(*) FROM evolution_states) AS states,
      (SELECT COUNT(*) FROM evolution_evidence) AS evidence,
      (SELECT COUNT(*) FROM evolution_goal_pins) AS pins,
      (SELECT COUNT(*) FROM outbox WHERE kind = 'evolution.model') AS model_outbox,
      (SELECT COUNT(*) FROM joi_inbox_messages) AS inbox,
      (SELECT COUNT(*) FROM work_items) AS work_items`).get());
    const before = counts();

    const report = await new EvolutionDryRun({ now: () => "2026-09-24T00:00:00.000Z", id: () => "dry-run" }).run("a");

    // A promoted verdict is what makes the isolation claim meaningful: the batch really did run.
    expect(report).toMatchObject({ outcome: "promoted", steps: 721 });
    expect(counts()).toEqual(before);
    // The workbench the dry run was asked about keeps the state it had before, rather than the state
    // the synthetic batch finished with.
    expect(store.read("a")).toMatchObject({ callSequence: 0, batch: null, usage: {}, revisions: [], activeRevisionId: null });
  } finally { await fixture.close(); }
});
