-- joi:migration add-column-if-missing partner_revisions engine_config_json
ALTER TABLE partner_revisions ADD COLUMN engine_config_json TEXT;
