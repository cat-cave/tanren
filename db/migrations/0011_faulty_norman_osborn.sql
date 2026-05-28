CREATE TABLE "forge_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"run_id" text,
	"scope" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "forge_threads_scope_check" CHECK ("forge_threads"."scope" IN ('org','project','run')),
	CONSTRAINT "forge_threads_scope_consistency_check" CHECK (("forge_threads"."scope" = 'org' AND "forge_threads"."project_id" IS NULL AND "forge_threads"."run_id" IS NULL)
        OR ("forge_threads"."scope" = 'project' AND "forge_threads"."project_id" IS NOT NULL AND "forge_threads"."run_id" IS NULL)
        OR ("forge_threads"."scope" = 'run' AND "forge_threads"."project_id" IS NOT NULL AND "forge_threads"."run_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "forge_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"source" jsonb NOT NULL,
	"audience" text NOT NULL,
	"author_kind" text NOT NULL,
	"render" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_turns_audience_check" CHECK ("forge_turns"."audience" IN ('project:member','project:admin','org:admin','platform:admin')),
	CONSTRAINT "forge_turns_author_kind_check" CHECK ("forge_turns"."author_kind" IN ('forge_template','forge_llm','operator'))
);
--> statement-breakpoint
ALTER TABLE "forge_threads" ADD CONSTRAINT "forge_threads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_threads" ADD CONSTRAINT "forge_threads_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_turns" ADD CONSTRAINT "forge_turns_thread_id_forge_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."forge_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forge_threads_org_id" ON "forge_threads" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "forge_threads_project_id" ON "forge_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "forge_threads_run_id" ON "forge_threads" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_turns_thread_index_unique" ON "forge_turns" USING btree ("thread_id","turn_index");--> statement-breakpoint
CREATE INDEX "forge_turns_thread_id" ON "forge_turns" USING btree ("thread_id");
