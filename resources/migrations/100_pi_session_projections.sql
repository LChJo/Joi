-- SDK session files own execution history. These tables are rebuildable projections.
-- Legacy readers must fail closed rather than execute projected messages after downgrade.
ALTER TABLE joi_session_messages RENAME TO joi_reasoning_projections;
ALTER TABLE partner_instance_messages RENAME TO partner_message_projections;
ALTER TABLE conversation_execution_sessions RENAME TO conversation_session_projections;
