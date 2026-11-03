ALTER TABLE alarms ADD COLUMN recurrence_rule TEXT CHECK (recurrence_rule IN ('DAILY', 'WEEKDAYS', 'WEEKENDS', 'WEEKLY'));
