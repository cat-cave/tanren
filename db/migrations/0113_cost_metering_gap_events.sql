-- Seed the three cost-metering-gap event names this PR emits. The
-- events.event_type and notification_routes.event_name FKs (migration 0040)
-- require each name in the event_types catalog BEFORE any real-DB emit, so the
-- budget-preflight refusal (`cost.ceiling_unenforceable`, `cost.route_unmeterable`)
-- and the generation-id drift signal (`cost.generation_id_missing`) never trip
-- the FK. Severities mirror db/src/eventTypesSeed.ts.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('cost.ceiling_unenforceable', 'fail'),
  ('cost.route_unmeterable', 'warn'),
  ('cost.generation_id_missing', 'warn')
ON CONFLICT ("name") DO NOTHING;
