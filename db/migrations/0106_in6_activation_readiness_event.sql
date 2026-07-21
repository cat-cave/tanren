-- in-6 repair: a blocked deriving→active readiness gate is a durable,
-- operator-actionable project fact. Register the typed event before its
-- repository emitter can write it through the events.event_type FK.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('project.activation.readiness_blocked', 'warn')
ON CONFLICT ("name") DO NOTHING;
