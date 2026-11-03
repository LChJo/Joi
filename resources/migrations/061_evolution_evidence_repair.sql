-- 修复策略进化的证据采集链路。三处历史遗留状态让证据永远无法收敛，进化因此一次都没有启动过：
--
-- 1) 被撤销（取消 / 忽略）的目标，其 harness map 永远停在 ACTIVE。评审清除与 AUTO_CLEAR 都要求
--    COMPLETED 终态，trivial clear 又要求目标从未派发过 Work，于是这些目标被证据扫描的“无 ACTIVE
--    map”条件永久排除——而失败信号恰恰集中在这条路径上。撤销时刻取自目标行本身，迁移没有时钟。
--
-- 2) 证据一生只写一次。过早的快照（目标还没派发第一个 Work 时就被扫到，此时既无 outcome 也无
--    work_items）会把之后发生的验收失败永久掩盖。新增 classified_at 承载幂等判定，observed_at
--    保持为裁决窗口时间戳，只在分类真正升级时前移，因此重复扫描不会重新武装已消费的触发证据。
--
-- 3) 059 把当时所有存量目标一次性标记为不采样，其中包含仍在途、整个结局都发生在迁移之后的目标。
--    这里按 059 的实际落库时间精确放行这部分；迁移时已终结的历史目标继续遵循“固定基线且不采样”
--    （见 migrations/README.md 与 ADR 0020 的零历史重跑）。
ALTER TABLE evolution_evidence ADD COLUMN classified_at TEXT NOT NULL DEFAULT '';
UPDATE evolution_evidence SET classified_at = observed_at WHERE classified_at = '';
UPDATE joi_harness_maps
   SET status = 'CLEARED',
       cleared_at = COALESCE(cleared_at,
         (SELECT COALESCE(g.canceled_at, g.dismissed_at, g.updated_at)
            FROM joi_inbox_messages g WHERE g.input_id = joi_harness_maps.goal_input_id)),
       feedback_recorded_at = COALESCE(feedback_recorded_at,
         (SELECT COALESCE(g.canceled_at, g.dismissed_at, g.updated_at)
            FROM joi_inbox_messages g WHERE g.input_id = joi_harness_maps.goal_input_id)),
       revision = revision + 1,
       updated_at = COALESCE(
         (SELECT g.updated_at FROM joi_inbox_messages g
           WHERE g.input_id = joi_harness_maps.goal_input_id), updated_at)
 WHERE status = 'ACTIVE'
   AND EXISTS (SELECT 1 FROM joi_inbox_messages g
                WHERE g.input_id = joi_harness_maps.goal_input_id
                  AND (g.canceled_at IS NOT NULL OR g.dismissed_at IS NOT NULL));
UPDATE evolution_goal_pins
   SET eligible = 1
 WHERE eligible = 0 AND revision_id IS NULL
   AND EXISTS (SELECT 1 FROM joi_inbox_messages g
                WHERE g.input_id = evolution_goal_pins.goal_id
                  AND g.updated_at > (SELECT applied_at FROM schema_migrations WHERE version = 59));
