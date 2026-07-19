-- rv-env: enforce ONE ready verification environment per live-deployment identity so the
-- find-or-create (ensureLiveVerificationEnvironment) is DB-serialized, not merely app-level
-- (SELECT-then-INSERT under an advisory lock only the deploy path holds — the demo/re-proof
-- env resolvers create OUTSIDE that lock, so the DB must guarantee no duplicate). The
-- identity includes environment_fingerprint (integration node · artifact · live URL), so a
-- re-deploy to the SAME URL reuses the row while a divergent URL yields a distinct env
-- (honest binding, never a verdict misattributed to the wrong deployment). Partial (WHERE
-- lifecycle_status = 'ready') so torn-down history rows never collide; the INSERT uses
-- `ON CONFLICT (<this tuple>) DO NOTHING`.
CREATE UNIQUE INDEX "verification_environments_live_identity_unique"
  ON "verification_environments" (
    "org_id", "project_id", "integration_node_id", "artifact_digest",
    "deployment_target", "environment_fingerprint"
  )
  WHERE "lifecycle_status" = 'ready';
