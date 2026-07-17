-- Back-half self-healing cluster barrier. Resolution jobs are stateful claim/
-- lease aggregates; decisions and remediation attempts are append-only evidence.
CREATE TABLE "resolution_jobs" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "id" text NOT NULL,
  "issue_loop_id" text NOT NULL,
  "contract_id" text NOT NULL,
  "release_instance_id" text,
  "stage" text NOT NULL,
  "state" text NOT NULL,
  "lease_owner" text,
  "lease_expiry" timestamp with time zone,
  "idempotency_key" text NOT NULL,
  "attempt" integer NOT NULL,
  "prior_attempt_id" text,
  CONSTRAINT "resolution_jobs_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "resolution_jobs_stage_check" CHECK ("resolution_jobs"."stage" IN ('baseline','production','counterfactual','soak')),
  CONSTRAINT "resolution_jobs_state_check" CHECK ("resolution_jobs"."state" IN ('queued','running','retryable','authorized','blocked','needs_attention','waived','completed')),
  CONSTRAINT "resolution_jobs_attempt_check" CHECK ("resolution_jobs"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "resolution_decisions" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "id" text NOT NULL,
  "resolution_job_id" text NOT NULL,
  "issue_loop_id" text NOT NULL,
  "decision" text NOT NULL,
  "input_snapshot_hash" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "resolution_decisions_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "resolution_decisions_decision_check" CHECK ("resolution_decisions"."decision" IN ('authorized','blocked','needs_attention','waived')),
  CONSTRAINT "resolution_decisions_input_snapshot_hash_check" CHECK ("resolution_decisions"."input_snapshot_hash" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "remediation_attempts" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "id" text NOT NULL,
  "issue_loop_id" text NOT NULL,
  "iteration" integer NOT NULL,
  "hypothesis" text NOT NULL,
  "spec_id" text,
  "run_id" text,
  "pr_ref" text,
  "merge_sha" text,
  "prior_attempt_id" text,
  "failure_signature" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "remediation_attempts_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "remediation_attempts_iteration_check" CHECK ("remediation_attempts"."iteration" >= 1)
);
--> statement-breakpoint
ALTER TABLE "resolution_jobs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "resolution_jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "resolution_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "resolution_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "remediation_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "remediation_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "resolution_jobs_org_project_id_unique" ON "resolution_jobs" USING btree ("org_id","project_id","id");
--> statement-breakpoint
CREATE INDEX "resolution_jobs_org_id" ON "resolution_jobs" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "resolution_decisions_org_id" ON "resolution_decisions" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "remediation_attempts_org_id" ON "remediation_attempts" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "resolution_jobs" ADD CONSTRAINT "resolution_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resolution_jobs" ADD CONSTRAINT "resolution_jobs_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resolution_jobs" ADD CONSTRAINT "resolution_jobs_issue_loop_fk" FOREIGN KEY ("org_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resolution_jobs" ADD CONSTRAINT "resolution_jobs_contract_fk" FOREIGN KEY ("org_id","contract_id") REFERENCES "public"."symptom_contracts"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resolution_jobs" ADD CONSTRAINT "resolution_jobs_release_instance_fk" FOREIGN KEY ("org_id","release_instance_id") REFERENCES "public"."release_instances"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resolution_decisions" ADD CONSTRAINT "resolution_decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resolution_decisions" ADD CONSTRAINT "resolution_decisions_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resolution_decisions" ADD CONSTRAINT "resolution_decisions_resolution_job_fk" FOREIGN KEY ("org_id","resolution_job_id") REFERENCES "public"."resolution_jobs"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resolution_decisions" ADD CONSTRAINT "resolution_decisions_issue_loop_fk" FOREIGN KEY ("org_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "remediation_attempts" ADD CONSTRAINT "remediation_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "remediation_attempts" ADD CONSTRAINT "remediation_attempts_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "remediation_attempts" ADD CONSTRAINT "remediation_attempts_issue_loop_fk" FOREIGN KEY ("org_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "remediation_attempts" ADD CONSTRAINT "remediation_attempts_spec_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "remediation_attempts" ADD CONSTRAINT "remediation_attempts_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "remediation_attempts" ADD CONSTRAINT "remediation_attempts_prior_attempt_fk" FOREIGN KEY ("org_id","prior_attempt_id") REFERENCES "public"."remediation_attempts"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "behavior_verification_runs" ADD COLUMN "stage" text;
--> statement-breakpoint
ALTER TABLE "behavior_verification_runs" ADD COLUMN "resolution_job_id" text;
--> statement-breakpoint
ALTER TABLE "behavior_verification_runs" ADD COLUMN "classification" text;
--> statement-breakpoint
ALTER TABLE "behavior_verification_runs" ADD CONSTRAINT "behavior_verification_runs_resolution_job_fk" FOREIGN KEY ("org_id","resolution_job_id") REFERENCES "public"."resolution_jobs"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "resolution_jobs";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "resolution_jobs" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "resolution_decisions";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "resolution_decisions" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "remediation_attempts";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "remediation_attempts" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE FUNCTION "enforce_resolution_decisions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'resolution_decisions rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "resolution_decisions_immutable"
BEFORE UPDATE OR DELETE ON "resolution_decisions"
FOR EACH ROW EXECUTE FUNCTION "enforce_resolution_decisions_immutable"();
--> statement-breakpoint
CREATE FUNCTION "enforce_remediation_attempts_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'remediation_attempts rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "remediation_attempts_immutable"
BEFORE UPDATE OR DELETE ON "remediation_attempts"
FOR EACH ROW EXECUTE FUNCTION "enforce_remediation_attempts_immutable"();
