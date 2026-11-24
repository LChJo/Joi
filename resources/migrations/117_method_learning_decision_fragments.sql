CREATE INDEX idx_joi_goal_evidence_reads_turn ON joi_goal_evidence_reads(goal_input_id,turn_id,result_revision,requirements_revision);

CREATE TABLE method_learning_residency (
  turn_id TEXT PRIMARY KEY REFERENCES joi_turns(turn_id) ON DELETE CASCADE,
  resident_json TEXT NOT NULL CHECK(json_valid(resident_json))
) STRICT;
CREATE TRIGGER method_learning_residency_finished AFTER UPDATE OF status ON joi_turns
WHEN NEW.status NOT IN ('RUNNING','WAITING') BEGIN
  DELETE FROM method_learning_residency WHERE turn_id=NEW.turn_id;
END;
CREATE TABLE method_learning_decision_receipts (
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  resident_json TEXT CHECK(resident_json IS NULL OR json_valid(resident_json)),
  authority TEXT NOT NULL,
  PRIMARY KEY(turn_id,tool_call_id),
  FOREIGN KEY(turn_id,tool_call_id) REFERENCES joi_goal_evidence_reads(turn_id,tool_call_id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER projection_learning_decision_body AFTER UPDATE OF body ON work_result_bodies BEGIN
  UPDATE read_projection_versions SET revision=lower(hex(randomblob(16))) WHERE projection_id='method_learning_facts';
END;
CREATE TRIGGER projection_learning_decision_receipt AFTER INSERT ON joi_goal_evidence_reads BEGIN
  UPDATE read_projection_versions SET revision=lower(hex(randomblob(16))) WHERE projection_id='method_learning_facts';
END;
CREATE TRIGGER projection_learning_decision_source AFTER INSERT ON method_learning_sources BEGIN
  UPDATE read_projection_versions SET revision=lower(hex(randomblob(16))) WHERE projection_id='method_learning_facts';
END;
