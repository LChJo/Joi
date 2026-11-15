DROP INDEX idx_method_learning_single_experiment;
CREATE UNIQUE INDEX idx_method_learning_single_experiment
ON method_learning_experiments((1))
WHERE status='RUNNING' OR (status='PAUSED' AND COALESCE(json_extract(state_json,'$.state.reason'),'')<>'insufficient_samples');
