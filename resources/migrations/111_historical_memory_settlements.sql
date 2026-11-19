CREATE TABLE historical_memory_settlements (
  source_id TEXT PRIMARY KEY REFERENCES historical_memory_sources(source_id) ON DELETE CASCADE,
  facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
  preferences_json TEXT NOT NULL CHECK (json_valid(preferences_json))
);
