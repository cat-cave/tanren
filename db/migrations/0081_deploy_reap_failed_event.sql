-- Seed the `deploy.reap_failed` event name (issue #1075). The events.event_type
-- and notification_routes.event_name FKs require the name in the event_types
-- catalog before any real-DB emit of the Fly-machine reap-failure signal.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('deploy.reap_failed', 'warn')
ON CONFLICT ("name") DO NOTHING;
