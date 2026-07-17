-- Mission-complete WAVE-4 shared event-vocabulary freeze. These names are
-- registered before their owning lanes emit them; values mirror the generated
-- db/src/eventTypesSeed.ts catalog.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('symptom.baseline.started', 'info'),
  ('symptom.baseline.observed', 'info'),
  ('symptom.assertion.recorded', 'info'),
  ('source.finding.recorded', 'info'),
  ('source.sync.pending', 'info'),
  ('source.sync.verified', 'info'),
  ('source.sync.externally_closed_unverified', 'warn'),
  ('merge.group.formed', 'info'),
  ('merge.land_group.completed', 'info'),
  ('governance.tier.created', 'info'),
  ('governance.tier.activated', 'info')
ON CONFLICT ("name") DO NOTHING;
