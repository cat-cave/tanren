-- Notional-pricing metering vocabulary. These names are registered before
-- their owning cost emitters can write them through the events.event_type FK
-- (migration 0040). Values mirror the generated db/src/eventTypesSeed.ts catalog.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('cost.ceiling_unenforceable', 'fail'),
  ('cost.generation_id_missing', 'warn'),
  ('cost.route_unmeterable', 'warn')
ON CONFLICT ("name") DO NOTHING;
