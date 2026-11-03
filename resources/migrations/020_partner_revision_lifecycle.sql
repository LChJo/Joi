ALTER TABLE partner_revisions ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
  CHECK (status IN ('ACTIVE', 'DISABLED', 'DELETED'));

UPDATE partner_revisions
   SET status = (SELECT p.status FROM partners p WHERE p.active_revision_id = partner_revisions.partner_revision_id)
 WHERE partner_revision_id IN (SELECT active_revision_id FROM partners WHERE active_revision_id IS NOT NULL);
