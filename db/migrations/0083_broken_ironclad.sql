CREATE TABLE "behavior_regression_bisections" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"behavior_revision_id" text NOT NULL,
	"failing_release_instance_id" text NOT NULL,
	"failing_verdict_id" text NOT NULL,
	"baseline_release_instance_id" text,
	"artifact_digest" text NOT NULL,
	"integration_node_id" text NOT NULL,
	"status" text NOT NULL,
	"culprit_release_instance_id" text,
	"culprit_integration_node_id" text,
	"inconclusive_reason" text,
	"candidate_count" integer NOT NULL,
	"probe_count" integer NOT NULL,
	"probe_trail" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "behavior_regression_bisections_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "behavior_regression_bisections_status_check" CHECK ("behavior_regression_bisections"."status" IN ('localized','inconclusive')),
	CONSTRAINT "behavior_regression_bisections_artifact_digest_check" CHECK ("behavior_regression_bisections"."artifact_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "behavior_regression_bisections_counts_check" CHECK ("behavior_regression_bisections"."candidate_count" >= 0 AND "behavior_regression_bisections"."probe_count" >= 0),
	CONSTRAINT "behavior_regression_bisections_outcome_shape_check" CHECK ((
        "behavior_regression_bisections"."status" = 'localized'
          AND "behavior_regression_bisections"."culprit_release_instance_id" IS NOT NULL
          AND "behavior_regression_bisections"."culprit_integration_node_id" IS NOT NULL
          AND "behavior_regression_bisections"."inconclusive_reason" IS NULL
      ) OR (
        "behavior_regression_bisections"."status" = 'inconclusive'
          AND "behavior_regression_bisections"."culprit_release_instance_id" IS NULL
          AND "behavior_regression_bisections"."culprit_integration_node_id" IS NULL
          AND "behavior_regression_bisections"."inconclusive_reason" IS NOT NULL
      ))
);
--> statement-breakpoint
ALTER TABLE "behavior_regression_bisections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "behavior_regression_bisections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "behavior_regression_bisections" ADD CONSTRAINT "behavior_regression_bisections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behavior_regression_bisections" ADD CONSTRAINT "behavior_regression_bisections_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "behavior_regression_bisections_org_id" ON "behavior_regression_bisections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "behavior_regression_bisections_verdict_unique" ON "behavior_regression_bisections" USING btree ("org_id","failing_verdict_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "behavior_regression_bisections" AS PERMISSIVE FOR ALL TO public USING ("behavior_regression_bisections"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("behavior_regression_bisections"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
-- Append-only bisection ledger: a localization (culprit or inconclusive) is a
-- sealed forensic record — never mutated or deleted (mirrors 0079/0078).
CREATE FUNCTION "enforce_behavior_regression_bisections_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'behavior_regression_bisections rows are immutable (append-only): % rejected', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "behavior_regression_bisections_immutable"
BEFORE UPDATE OR DELETE ON "behavior_regression_bisections"
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_regression_bisections_immutable"();
