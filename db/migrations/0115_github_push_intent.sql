CREATE TABLE "github_push_intents" (
	"intent_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"run_id" text NOT NULL,
	"spec_id" text NOT NULL,
	"repo_url" text NOT NULL,
	"branch" text NOT NULL,
	"intended_sha" text NOT NULL,
	"source_ref" text NOT NULL,
	"lease_predecessor_sha" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "github_push_intents_status_check" CHECK (("github_push_intents"."status" = 'pending' AND "github_push_intents"."completed_at" IS NULL) OR ("github_push_intents"."status" = 'completed' AND "github_push_intents"."completed_at" IS NOT NULL)),
	CONSTRAINT "github_push_intents_sha_check" CHECK ("github_push_intents"."intended_sha" ~ '^[0-9a-f]{40}$' AND "github_push_intents"."source_ref" ~ '^[0-9a-f]{40}$'),
	CONSTRAINT "github_push_intents_source_sha_check" CHECK ("github_push_intents"."source_ref" = "github_push_intents"."intended_sha"),
	CONSTRAINT "github_push_intents_predecessor_sha_check" CHECK ("github_push_intents"."lease_predecessor_sha" IS NULL OR "github_push_intents"."lease_predecessor_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "github_push_intents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_push_intents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "github_push_intents" ADD CONSTRAINT "github_push_intents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_push_intents" ADD CONSTRAINT "github_push_intents_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_push_intents" ADD CONSTRAINT "github_push_intents_run_fk" FOREIGN KEY ("org_id","run_id") REFERENCES "public"."runs"("org_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_push_intents" ADD CONSTRAINT "github_push_intents_spec_fk" FOREIGN KEY ("org_id","spec_id") REFERENCES "public"."specs"("org_id","spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_push_intents_org_id" ON "github_push_intents" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "github_push_intents_org_spec_branch" ON "github_push_intents" USING btree ("org_id","spec_id","branch");--> statement-breakpoint
CREATE UNIQUE INDEX "github_push_intents_pending_unique" ON "github_push_intents" USING btree ("org_id","spec_id","branch") WHERE "github_push_intents"."status" = 'pending';--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "github_push_intents" AS PERMISSIVE FOR ALL TO public USING ("github_push_intents"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("github_push_intents"."org_id" = current_setting('app.current_org_id', true));
