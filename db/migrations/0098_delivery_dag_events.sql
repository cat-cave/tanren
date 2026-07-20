-- in-17 durable post-merge delivery DAG (release activation). The events.event_type
-- and notification_routes.event_name FKs require these names in the platform-global
-- event_types catalog before any real-DB emit of the delivery attestations:
--   delivery.completed → the delivery DAG confirmed every applicable stage and recorded
--                        the signed evidence of the independently-observed effect (info).
--   delivery.degraded  → a stage could not confirm its external effect; the delivery is
--                        in an explicit durable degraded state, not silently complete (warn).
-- NOTE: claims migration slot 0098 (0097 is reserved by a concurrent node).
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('delivery.completed', 'info'),
  ('delivery.degraded', 'warn')
ON CONFLICT ("name") DO NOTHING;
