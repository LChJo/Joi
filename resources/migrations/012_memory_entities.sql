CREATE TABLE memory_entities (
  entity_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (life_id, normalized_name, entity_type)
);

CREATE TABLE memory_entity_links (
  link_id TEXT PRIMARY KEY,
  life_id TEXT NOT NULL REFERENCES lives(life_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_fragments(memory_id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES memory_entities(entity_id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (memory_id, entity_id, relation)
);

CREATE INDEX idx_memory_entities_lookup ON memory_entities(life_id, normalized_name);
CREATE INDEX idx_memory_entity_links_memory ON memory_entity_links(memory_id, entity_id);
