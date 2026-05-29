CREATE TABLE "candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"triage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_spec_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_severity_check" CHECK ("candidates"."severity" IN ('info','warn','fail')),
	CONSTRAINT "candidates_status_check" CHECK ("candidates"."status" IN ('new','triaged','auto_routed','accepted','folded','dismissed','closed_duplicate'))
);
--> statement-breakpoint
CREATE TABLE "inbox_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" text DEFAULT 'true' NOT NULL,
	"auto_route" text DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_sources_kind_check" CHECK ("inbox_sources"."kind" IN ('issues','errors','system','manual','scheduled_audit')),
	CONSTRAINT "inbox_sources_enabled_check" CHECK ("inbox_sources"."enabled" IN ('true','false')),
	CONSTRAINT "inbox_sources_auto_route_check" CHECK ("inbox_sources"."auto_route" IN ('true','false'))
);
--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_source_id_inbox_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inbox_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_resolved_spec_id_specs_spec_id_fk" FOREIGN KEY ("resolved_spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_sources" ADD CONSTRAINT "inbox_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_sources" ADD CONSTRAINT "inbox_sources_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_source_external_unique" ON "candidates" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "candidates_org_id" ON "candidates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "candidates_project_id" ON "candidates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "candidates_status" ON "candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inbox_sources_org_id" ON "inbox_sources" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "inbox_sources_project_id" ON "inbox_sources" USING btree ("project_id");
