CREATE TABLE "notification_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"event_name" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"min_severity" text DEFAULT 'info' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_routes_min_severity_check" CHECK ("notification_routes"."min_severity" IN ('ok','info','warn','fail')),
	CONSTRAINT "notification_routes_event_name_check" CHECK ("notification_routes"."event_name" IN ('allocator.allocated','allocator.failed','allocator.requested','auditor.completed','auditor.failed','auditor.started','auditor.verdict','checker.completed','checker.failed','checker.started','checker.verdict','ci.failed','ci.passed','ci.started','cost.failed','cost.resolved','cost.unattributable','credential.failed','credential.loaded','credential.requested','github.branch.pushed','github.failed','github.pr.created','github.pr.merged','github.pr.ready','hello.completed','hello.ssh_completed','hello.ssh_started','hello.started','notification.enqueued','notification.failed','notification.sent','phase1.fixture.ci_pending','phase1.fixture.completed','phase1.fixture.failed','phase1.fixture.started','planner.completed','planner.failed','planner.started','planner.subtasks.emitted','redaction.raw_access','review.approved','review.changes_requested','review.requested','run.completed','run.failed','run.queued','run.started','runner.allocated','runner.failed','runner.released','task.completed','task.failed','task.queued','task.started','workspace.failed','workspace.git_captured','workspace.prepared','writer.completed','writer.failed','writer.started','writer.subtask.completed','writer.subtask.failed','writer.subtask.started')),
	CONSTRAINT "notification_routes_enabled_check" CHECK ("notification_routes"."enabled" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "notification_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"channel_kind" text NOT NULL,
	"destination" text NOT NULL,
	"label" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"weekend_mute" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_targets_channel_kind_check" CHECK ("notification_targets"."channel_kind" IN ('ntfy','slack','github_checks','teams','discord','email','twilio','pagerduty','webhook')),
	CONSTRAINT "notification_targets_scope_check" CHECK ("notification_targets"."scope" IN ('org','user')),
	CONSTRAINT "notification_targets_scope_user_check" CHECK (("notification_targets"."scope" = 'org' AND "notification_targets"."user_id" IS NULL) OR ("notification_targets"."scope" = 'user' AND "notification_targets"."user_id" IS NOT NULL)),
	CONSTRAINT "notification_targets_enabled_check" CHECK ("notification_targets"."enabled" IN (0,1)),
	CONSTRAINT "notification_targets_weekend_mute_check" CHECK ("notification_targets"."weekend_mute" IN (0,1))
);
--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_target_id_notification_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."notification_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_routes_target_event_unique" ON "notification_routes" USING btree ("target_id","event_name");--> statement-breakpoint
CREATE INDEX "notification_routes_event_name" ON "notification_routes" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "notification_targets_org_id" ON "notification_targets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "notification_targets_user_id" ON "notification_targets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_targets_channel_kind" ON "notification_targets" USING btree ("channel_kind");
