CREATE TABLE work_result_artifact_index (
  result_id TEXT NOT NULL REFERENCES work_results(result_id) ON DELETE CASCADE,
  artifact_index INTEGER NOT NULL,
  relative_path TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size REAL NOT NULL,
  PRIMARY KEY (result_id, artifact_index)
);
CREATE INDEX idx_work_result_artifact_path
  ON work_result_artifact_index(relative_path, result_id, artifact_index);

-- Only validated workspace metadata enters the read index. The source manifest remains intact.
CREATE VIEW work_result_artifact_candidates AS
WITH entries AS (
  SELECT r.result_id, CAST(j.key AS INTEGER) AS artifact_index,
         CASE WHEN j.type = 'object' THEN j.value ELSE '{}' END AS item
    FROM work_results r,
         json_each(CASE WHEN json_valid(r.artifacts_json)
                        THEN CASE WHEN json_type(r.artifacts_json) = 'array' THEN r.artifacts_json ELSE '[]' END
                        ELSE '[]' END) j
), typed AS (
  SELECT result_id, artifact_index, substr(json_extract(item, '$.artifactRef'), 11) AS relative_path,
         json_extract(item, '$.name') AS name,
         CASE WHEN json_type(item, '$.mimeType') = 'text' THEN json_extract(item, '$.mimeType')
              ELSE 'application/octet-stream' END AS mime_type,
         json_extract(item, '$.size') AS size
    FROM entries
   WHERE json_type(item, '$.artifactRef') = 'text'
     AND substr(json_extract(item, '$.artifactRef'), 1, 10) = 'workspace:'
     AND json_type(item, '$.name') = 'text'
     AND json_type(item, '$.size') IN ('integer', 'real')
)
SELECT result_id, artifact_index, relative_path, name, mime_type, size
  FROM typed
 WHERE length(relative_path) > 0
   AND instr(relative_path, '\') = 0 AND instr(relative_path, char(0)) = 0
   AND substr(relative_path, 1, 1) <> '/' AND relative_path NOT GLOB '[a-zA-Z]:*'
   AND instr('/' || relative_path || '/', '//') = 0
   AND instr('/' || relative_path || '/', '/./') = 0
   AND instr('/' || relative_path || '/', '/../') = 0
   AND relative_path NOT IN ('.git', 'node_modules')
   AND relative_path NOT GLOB '.git/*' AND relative_path NOT GLOB 'node_modules/*';

INSERT INTO work_result_artifact_index SELECT * FROM work_result_artifact_candidates;

CREATE TRIGGER work_result_artifact_index_insert AFTER INSERT ON work_results
BEGIN
  INSERT INTO work_result_artifact_index
    SELECT * FROM work_result_artifact_candidates WHERE result_id = NEW.result_id;
END;

CREATE TRIGGER work_result_artifact_index_update AFTER UPDATE OF artifacts_json ON work_results
BEGIN
  DELETE FROM work_result_artifact_index WHERE result_id = OLD.result_id;
  INSERT INTO work_result_artifact_index
    SELECT * FROM work_result_artifact_candidates WHERE result_id = NEW.result_id;
END;

CREATE TRIGGER work_result_artifact_index_delete AFTER DELETE ON work_results
BEGIN
  DELETE FROM work_result_artifact_index WHERE result_id = OLD.result_id;
END;
