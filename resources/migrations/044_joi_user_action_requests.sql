-- A visible "needs you" state must have a durable, actionable cause. Partner
-- questions link the goal input to the exact Work/Run that must resume.
CREATE TABLE joi_user_action_requests (
  action_id TEXT PRIMARY KEY,
  input_id TEXT NOT NULL REFERENCES joi_inbox_messages(input_id) ON DELETE RESTRICT,
  work_id TEXT NOT NULL REFERENCES work_items(work_id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES partner_runs(run_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('PARTNER_QUESTION', 'RECOVERY_DECISION')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED', 'APPLIED', 'CANCELED')),
  reason_code TEXT NOT NULL,
  prompt TEXT NOT NULL,
  decision TEXT CHECK (decision IS NULL OR decision IN ('RESUME')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  applied_at TEXT
);

CREATE UNIQUE INDEX idx_joi_user_action_one_open_per_input
  ON joi_user_action_requests(input_id) WHERE status = 'OPEN';
CREATE INDEX idx_joi_user_action_resolved
  ON joi_user_action_requests(status, updated_at, action_id);

-- Upgrade repair: old builds could leave a WAITING Work after consuming the
-- question. Preserve safety by asking for one explicit click instead of blindly
-- replaying a Work whose side effects may already have been observed elsewhere.
INSERT INTO joi_user_action_requests
  (action_id, input_id, work_id, run_id, kind, status, reason_code, prompt, created_at, updated_at)
SELECT 'joi_action:recovery:' || pr.run_id, w.input_id, w.work_id, pr.run_id,
       CASE WHEN pr.status = 'WAITING_INPUT' AND i.status = 'CLARIFICATION_REQUIRED' AND i.clarification_reason_code = 'question_required'
         THEN 'PARTNER_QUESTION' ELSE 'RECOVERY_DECISION' END,
       'OPEN',
       CASE WHEN pr.status = 'WAITING_AUTH' THEN 'partner_auth_required'
         WHEN i.status = 'CLARIFICATION_REQUIRED' AND i.clarification_reason_code = 'question_required'
         THEN 'question_required' ELSE 'partner_waiting_recovery_required' END,
       CASE WHEN pr.status = 'WAITING_AUTH'
         THEN '搭档需要重新授权。请先在搭档设置完成授权，然后点击“继续原工作”。'
         WHEN i.status = 'CLARIFICATION_REQUIRED' AND i.clarification_reason_code = 'question_required'
         THEN COALESCE(i.clarification_prompt, '搭档正在等待你的回答。')
         ELSE '一项搭档工作仍在等待，但原来的提问卡已经失去关联。点击“继续原工作”可从已保存的上下文恢复；如果不希望继续，可以取消这条任务。' END,
       pr.updated_at, pr.updated_at
  FROM work_items w
  JOIN joi_inbox_messages i ON i.input_id = w.input_id
  JOIN partner_runs pr ON pr.work_id = w.work_id AND pr.status IN ('WAITING_INPUT', 'WAITING_AUTH')
 WHERE w.status = 'WAITING'
   AND pr.run_id = (
     SELECT pr2.run_id FROM partner_runs pr2
     JOIN work_items w2 ON w2.work_id = pr2.work_id
      WHERE w2.input_id = w.input_id AND w2.status = 'WAITING'
        AND pr2.status IN ('WAITING_INPUT', 'WAITING_AUTH')
      ORDER BY pr2.updated_at DESC, pr2.run_id DESC LIMIT 1
   )
   AND NOT EXISTS (SELECT 1 FROM joi_user_action_requests a WHERE a.input_id = w.input_id AND a.status IN ('OPEN', 'RESOLVED'));

UPDATE joi_inbox_messages
   SET status = 'CLARIFICATION_REQUIRED',
       clarification_reason_code = (SELECT a.reason_code FROM joi_user_action_requests a
         WHERE a.input_id = joi_inbox_messages.input_id AND a.status = 'OPEN' LIMIT 1),
       clarification_prompt = (SELECT a.prompt FROM joi_user_action_requests a
         WHERE a.input_id = joi_inbox_messages.input_id AND a.status = 'OPEN' LIMIT 1),
       updated_at = (SELECT a.updated_at FROM joi_user_action_requests a
         WHERE a.input_id = joi_inbox_messages.input_id AND a.status = 'OPEN' LIMIT 1)
 WHERE EXISTS (SELECT 1 FROM joi_user_action_requests a
   WHERE a.input_id = joi_inbox_messages.input_id AND a.status = 'OPEN');
