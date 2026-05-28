CREATE TABLE "workflow_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"project_id" text NOT NULL,
	"severity" text NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	CONSTRAINT "workflow_insights_kind_check" CHECK ("workflow_insights"."kind" IN ('retry_hotspot','model_mismatch','pace_anomaly')),
	CONSTRAINT "workflow_insights_severity_check" CHECK ("workflow_insights"."severity" IN ('info','warn','fail'))
);
--> statement-breakpoint
ALTER TABLE "workflow_insights" ADD CONSTRAINT "workflow_insights_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_insights" ADD CONSTRAINT "workflow_insights_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_insights_project_kind" ON "workflow_insights" USING btree ("project_id","kind","computed_at" desc);
