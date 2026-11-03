-- System crash-loop parking is not user cancellation. Persist a bounded reason and
-- retry count so the UI can explain what stopped and what the user can do next.
ALTER TABLE joi_inbox_messages ADD COLUMN failed_at TEXT;
ALTER TABLE joi_inbox_messages ADD COLUMN failure_reason_code TEXT;
ALTER TABLE joi_inbox_messages ADD COLUMN failure_count INTEGER CHECK (failure_count IS NULL OR failure_count > 0);

-- Migration 028 reused canceled_at for scheduler parking. Conservatively recover
-- legacy rows only when they have the exact crash-loop shape: no Work and at least
-- eight failed orchestration turns. The historical exact reason was not persisted.
UPDATE joi_inbox_messages
   SET failed_at = canceled_at,
       canceled_at = NULL,
       failure_reason_code = 'legacy_scheduler_failure',
       failure_count = (SELECT COUNT(*) FROM joi_turns t
                         WHERE t.input_id = joi_inbox_messages.input_id
                           AND t.status = 'FAILED')
 WHERE canceled_at IS NOT NULL
   AND status = 'CONSUMED'
   AND NOT EXISTS (SELECT 1 FROM work_items w WHERE w.input_id = joi_inbox_messages.input_id)
   AND (SELECT COUNT(*) FROM joi_turns t
         WHERE t.input_id = joi_inbox_messages.input_id
           AND t.status = 'FAILED') >= 8;
