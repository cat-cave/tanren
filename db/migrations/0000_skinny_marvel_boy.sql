CREATE TABLE "cost_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"cli" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"pricing_mode" text NOT NULL,
	"cost_source" text NOT NULL,
	"cost_source_raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" text,
	"user_id" text,
	CONSTRAINT "cost_records_pricing_mode_check" CHECK ("cost_records"."pricing_mode" IN ('per_token','opportunity_cost','subscription_window')),
	CONSTRAINT "cost_records_cost_source_check" CHECK ("cost_records"."cost_source" IN ('provider_direct','ccusage','codexbar','opportunity_computed'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text,
	"task_id" text,
	"spec_id" text,
	"project_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tenant_id" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text,
	"task_kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"tenant_id" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"tenant_id" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo_url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"runner_image" text DEFAULT 'ghcr.io/cat-cave/tanren-runner:v0' NOT NULL,
	"allocator" text DEFAULT 'local-docker' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" text
);
--> statement-breakpoint
CREATE TABLE "rate_limit_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" text,
	"call_site" text NOT NULL,
	"provider" text NOT NULL,
	"observation" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retry_after_s" integer,
	"tenant_id" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"runner_id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"project_id" text,
	"allocator" text NOT NULL,
	"status" text NOT NULL,
	"ssh_host" text NOT NULL,
	"ssh_port" integer NOT NULL,
	"host_key_fingerprint" text NOT NULL,
	"image_sha" text NOT NULL,
	"container_id" text,
	"hcloud_server_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"tenant_id" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"spec_id" text NOT NULL,
	"project_id" text NOT NULL,
	"trigger" text NOT NULL,
	"branch" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"pr_url" text,
	"tenant_id" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "specs" (
	"spec_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tenant_id" text
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"task_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"parent_task_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"failure_kind" text,
	"agent_kind" text NOT NULL,
	"cli" text NOT NULL,
	"model" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"tenant_id" text,
	"user_id" text
);
--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_observations" ADD CONSTRAINT "rate_limit_observations_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_task_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_run_id_ts" ON "events" USING btree ("run_id","ts");--> statement-breakpoint
CREATE INDEX "events_event_type" ON "events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "job_queue_pending" ON "job_queue" USING btree ("task_kind","enqueued_at") WHERE "job_queue"."status" = 'pending';
