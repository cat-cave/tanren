-- Mission-complete WAVE-5 shared event-vocabulary freeze. These names are
-- registered before their owning lanes emit them; values mirror the generated
-- db/src/eventTypesSeed.ts catalog.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('governance.binding.activated', 'info'),
  ('governance.effective_policy.recorded', 'info'),
  ('governance.binding.superseded', 'info'),
  ('integration.node.materialized', 'info'),
  ('integration.node.materialization_failed', 'warn'),
  ('design.artifact.published', 'info'),
  ('design.catalog.built', 'info'),
  ('design.export.produced', 'info')
ON CONFLICT ("name") DO NOTHING;
