/** Keep one visible Work path per goal without deleting referenced historical rows. */
export function visibleHarnessPathSql(alias: string): string {
  return `(${alias}.work_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM joi_harness_paths newer
    WHERE newer.goal_input_id=${alias}.goal_input_id AND newer.work_id=${alias}.work_id
      AND (newer.layer>${alias}.layer
        OR (newer.layer=${alias}.layer AND newer.created_at>${alias}.created_at)
        OR (newer.layer=${alias}.layer AND newer.created_at=${alias}.created_at AND newer.path_id>${alias}.path_id))
  ))`;
}
