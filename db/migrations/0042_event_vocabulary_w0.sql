INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('integration.requirement.validated', 'info'),
  ('behavior.coverage.selection_analyzed', 'info'),
  ('governance.audit_posture.updated', 'info'),
  ('review.simulated_intent', 'info'),
  ('merge.signal.classified', 'info'),
  ('merge.member.policy_blocked', 'warn')
ON CONFLICT ("name") DO NOTHING;
