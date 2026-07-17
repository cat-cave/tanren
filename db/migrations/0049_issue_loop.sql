CREATE TABLE "issue_loop_edges" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"issue_loop_id" text NOT NULL,
	"related_issue_loop_id" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_loop_edges_org_id_project_id_issue_loop_id_related_issue_loop_id_relation_pk" PRIMARY KEY("org_id","project_id","issue_loop_id","related_issue_loop_id","relation"),
	CONSTRAINT "issue_loop_edges_relation_check" CHECK ("issue_loop_edges"."relation" IN ('duplicate_of','supersedes','regression_of','caused_by','split_from')),
	CONSTRAINT "issue_loop_edges_no_self_check" CHECK ("issue_loop_edges"."issue_loop_id" <> "issue_loop_edges"."related_issue_loop_id")
);
--> statement-breakpoint
ALTER TABLE "issue_loop_edges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "issue_loops" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_id" text NOT NULL,
	"external_key" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"source_revision_id" text,
	"current_contract_id" text,
	"current_attempt_id" text,
	"resolution_policy" text DEFAULT 'active_causal' NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_loops_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "issue_loops_generation_check" CHECK ("issue_loops"."generation" >= 1),
	CONSTRAINT "issue_loops_row_version_check" CHECK ("issue_loops"."row_version" >= 1),
	CONSTRAINT "issue_loops_severity_check" CHECK ("issue_loops"."severity" IN ('critical','high','medium','low','info')),
	CONSTRAINT "issue_loops_state_check" CHECK ("issue_loops"."state" IN ('open','awaiting_reproduction','reproduced','triaged','remediating','verifying','verified_source_sync_pending','verified_closed','externally_closed_unverified','needs_attention','wont_fix')),
	CONSTRAINT "issue_loops_resolution_policy_check" CHECK ("issue_loops"."resolution_policy" IN ('active_causal','active_plus_soak','observational','attested'))
);
--> statement-breakpoint
ALTER TABLE "issue_loops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "source_findings" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"issue_loop_id" text NOT NULL,
	"source_id" text NOT NULL,
	"provider_object_id" text NOT NULL,
	"provider_revision" text NOT NULL,
	"delivery_id" text,
	"status" text NOT NULL,
	"release" text,
	"environment" text,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"raw_artifact_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_findings_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "source_findings_status_check" CHECK ("source_findings"."status" IN ('open','closed','reopened','edited','deleted','unknown'))
);
--> statement-breakpoint
ALTER TABLE "source_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_loops_org_project_id_unique" ON "issue_loops" USING btree ("org_id","project_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_loops_source_external_generation_unique" ON "issue_loops" USING btree ("org_id","source_id","external_key","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "source_findings_provider_revision_unique" ON "source_findings" USING btree ("org_id","source_id","provider_object_id","provider_revision");--> statement-breakpoint
ALTER TABLE "issue_loop_edges" ADD CONSTRAINT "issue_loop_edges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_loop_edges" ADD CONSTRAINT "issue_loop_edges_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_loop_edges" ADD CONSTRAINT "issue_loop_edges_loop_fk" FOREIGN KEY ("org_id","project_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_loop_edges" ADD CONSTRAINT "issue_loop_edges_related_fk" FOREIGN KEY ("org_id","project_id","related_issue_loop_id") REFERENCES "public"."issue_loops"("org_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_loops" ADD CONSTRAINT "issue_loops_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_loops" ADD CONSTRAINT "issue_loops_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_loops" ADD CONSTRAINT "issue_loops_source_fk" FOREIGN KEY ("org_id","source_id") REFERENCES "public"."inbox_sources"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_findings" ADD CONSTRAINT "source_findings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_findings" ADD CONSTRAINT "source_findings_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_findings" ADD CONSTRAINT "source_findings_issue_loop_fk" FOREIGN KEY ("org_id","project_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_findings" ADD CONSTRAINT "source_findings_source_fk" FOREIGN KEY ("org_id","source_id") REFERENCES "public"."inbox_sources"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_loop_edges_org_id" ON "issue_loop_edges" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "issue_loop_edges_org_related" ON "issue_loop_edges" USING btree ("org_id","project_id","related_issue_loop_id");--> statement-breakpoint
CREATE INDEX "issue_loops_org_id" ON "issue_loops" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "issue_loops_org_project" ON "issue_loops" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "issue_loops_org_project_state" ON "issue_loops" USING btree ("org_id","project_id","state");--> statement-breakpoint
CREATE INDEX "source_findings_org_id" ON "source_findings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "source_findings_org_loop_observed" ON "source_findings" USING btree ("org_id","issue_loop_id","observed_at");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "issue_loop_edges" AS PERMISSIVE FOR ALL TO public USING ("issue_loop_edges"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("issue_loop_edges"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "issue_loops" AS PERMISSIVE FOR ALL TO public USING ("issue_loops"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("issue_loops"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "source_findings" AS PERMISSIVE FOR ALL TO public USING ("source_findings"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("source_findings"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
ALTER TABLE "issue_loops" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "source_findings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_loop_edges" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- source_findings is an immutable, append-only log: a new provider revision is a
-- NEW row, and prior revisions are never overwritten or removed. Enforce that at
-- the database so the invariant holds even against a system-credentialed client
-- (drizzle does not manage triggers; this is intentional hand-authored SQL).
CREATE FUNCTION "enforce_source_findings_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source_findings rows are immutable (append-only): % rejected', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "source_findings_immutable"
BEFORE UPDATE OR DELETE ON "source_findings"
FOR EACH ROW EXECUTE FUNCTION "enforce_source_findings_immutable"();
