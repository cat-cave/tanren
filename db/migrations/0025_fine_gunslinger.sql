CREATE TABLE "audit_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"cadence" text NOT NULL,
	"target_window" text DEFAULT '' NOT NULL,
	"answerer_cli" text DEFAULT '' NOT NULL,
	"enabled" text DEFAULT 'true' NOT NULL,
	"last_run" timestamp with time zone,
	"findings" jsonb DEFAULT '{"count":0,"severity":"ok","note":""}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_jobs_kind_check" CHECK ("audit_jobs"."kind" IN ('security','deps','a11y','mutation','perf','license','stale_specs')),
	CONSTRAINT "audit_jobs_cadence_check" CHECK ("audit_jobs"."cadence" IN ('nightly','weekly','monthly')),
	CONSTRAINT "audit_jobs_enabled_check" CHECK ("audit_jobs"."enabled" IN ('true','false'))
);
--> statement-breakpoint
ALTER TABLE "audit_jobs" ADD CONSTRAINT "audit_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_jobs" ADD CONSTRAINT "audit_jobs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_jobs_org_id" ON "audit_jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_jobs_project_id" ON "audit_jobs" USING btree ("project_id");
