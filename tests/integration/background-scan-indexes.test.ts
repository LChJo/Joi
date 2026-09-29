import { createRuntimeFixture } from "../support/runtime-fixture";

describe("background scan indexes", () => {
  it("keeps harness and evolution recovery scans on their bounded lookup keys", async () => {
    const fixture = await createRuntimeFixture();
    try {
      const indexes = fixture.database.transaction((database) => (database.prepare(`
        SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'idx_joi_harness_maps_status_updated',
           'idx_joi_harness_paths_work',
           'idx_joi_turns_input_status_effect',
           'idx_partner_result_events_work',
           'idx_work_items_input_status',
           'idx_work_results_authoritative_work_created'
         ) ORDER BY name`).all() as { name: string }[]).map((row) => row.name));

      expect(indexes).toEqual([
        "idx_joi_harness_maps_status_updated",
        "idx_joi_harness_paths_work",
        "idx_joi_turns_input_status_effect",
        "idx_partner_result_events_work",
        "idx_work_items_input_status",
        "idx_work_results_authoritative_work_created",
      ]);
    } finally {
      await fixture.close();
    }
  });
});
