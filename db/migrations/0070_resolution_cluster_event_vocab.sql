-- Back-half self-healing cluster shared event vocabulary. Existing
-- symptom.baseline.*, symptom.assertion.recorded, symptom.contract.*, and
-- source.finding.recorded names remain owned by their already-frozen migrations.
-- `triage.*` predates this barrier and is included idempotently in the full list.
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('issue_loop.opened', 'info'),
  ('issue_loop.source_revision_observed', 'info'),
  ('issue_loop.reopened', 'warn'),
  ('issue_loop.verified', 'info'),
  ('triage.started', 'info'),
  ('triage.completed', 'info'),
  ('spec.origin.linked', 'info'),
  ('remediation.attempt.started', 'info'),
  ('remediation.repair_routed', 'warn'),
  ('deployment.artifact.bound', 'info'),
  ('symptom.verification.started', 'info'),
  ('symptom.verification.passed', 'info'),
  ('symptom.verification.failed', 'warn'),
  ('symptom.verification.inconclusive', 'warn'),
  ('symptom.soak.completed', 'info'),
  ('resolution.authorized', 'info'),
  ('resolution.blocked', 'warn'),
  ('resolution.needs_attention', 'warn'),
  ('resolution.waived', 'warn'),
  ('source_issue.sync.enqueued', 'info'),
  ('source_issue.sync.succeeded', 'info'),
  ('source_issue.sync.failed', 'warn'),
  ('source_issue.sync.drifted', 'warn'),
  ('resolution.proof.sealed', 'info')
ON CONFLICT ("name") DO NOTHING;
