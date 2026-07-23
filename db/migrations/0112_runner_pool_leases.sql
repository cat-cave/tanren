ALTER TABLE "runners" ADD COLUMN "pool_key" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "lease_key" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "runners" ADD COLUMN "fencing_token" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "runners_live_lease_key_uniq" ON "runners" USING btree ("org_id","lease_key") WHERE "runners"."lease_key" IS NOT NULL AND "runners"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX "runners_pool_live" ON "runners" USING btree ("org_id","pool_key") WHERE "runners"."released_at" IS NULL;--> statement-breakpoint
-- ===========================================================================
-- #1254 hazard C — cross-process fixed-pool lease reservation (hand-written;
-- drizzle-kit does not emit sequences, FORCE ROW LEVEL SECURITY, or the RLS
-- policy re-assertion). Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS) so a
-- re-run is a no-op.
-- ===========================================================================

-- Monotonic fencing-token source, shared across every orchestrator process on the
-- host. `reservePoolLease` stamps each claim with `nextval(...)`, and release
-- requires the token to match — so a stale process cannot release a lease that was
-- released + re-claimed under a newer token.
CREATE SEQUENCE IF NOT EXISTS "runner_lease_fencing_token_seq" AS bigint;--> statement-breakpoint

-- `runners` is a tenant table: the baseline ENABLEd RLS + created the
-- rls_org_isolation policy, but did NOT FORCE it (so the table owner still bypassed
-- the policy). The lease columns now carry cross-process reservation state, so the
-- org boundary must hold even for the owner role. FORCE it and re-assert the
-- USING + WITH CHECK org policy (idempotent).
ALTER TABLE "runners" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runners" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "rls_org_isolation" ON "runners";--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "runners" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
