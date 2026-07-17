-- Mission-complete WAVE-3 event-vocabulary FREEZE seed. These names are
-- registered before their owning lanes emit them; the values mirror the
-- generated db/src/eventTypesSeed.ts catalog.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('merge.member.isolated', 'warn'),
  ('merge.partition.leased', 'info'),
  ('merge.partition.released', 'info'),
  ('symptom.contract.authored', 'info'),
  ('symptom.contract.authoring_failed', 'fail'),
  ('symptom.contract.superseded', 'info'),
  ('symptom.contract.validated', 'info')
ON CONFLICT ("name") DO NOTHING;
