CREATE TABLE historical_preference_watermarks (
  topic TEXT PRIMARY KEY,
  input_created_at TEXT NOT NULL,
  input_sequence INTEGER NOT NULL
);

INSERT INTO historical_preference_watermarks (topic,input_created_at,input_sequence)
SELECT json_extract(e.value,'$.key'), i.created_at, i.rowid
FROM historical_memories m, json_each(m.entries_json) e
JOIN historical_memory_sources s ON s.source_id=json_extract(e.value,'$.source')
JOIN joi_inbox_messages i ON i.input_id=s.subject_id
WHERE m.scope='joi' AND m.owner_id='local'
  AND json_extract(e.value,'$.section')='preferences'
  AND json_type(e.value,'$.key')='text';
