CREATE INDEX idx_life_events_timeline
  ON life_events(life_id, occurred_at DESC, event_id DESC);
