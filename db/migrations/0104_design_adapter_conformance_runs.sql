CREATE TABLE "design_adapter_conformance_runs" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"release_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"target" text NOT NULL,
	"adapter_version" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"receipt_digest" text NOT NULL,
	"receipt" jsonb,
	"outcome" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_adapter_conformance_runs_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_adapter_conformance_runs_target_check" CHECK ("design_adapter_conformance_runs"."target" IN ('web-react','generic-web','bevy','swiftui','jetpack-compose','flutter','react-native','document-media')),
	CONSTRAINT "design_adapter_conformance_runs_outcome_check" CHECK ("design_adapter_conformance_runs"."outcome" IN ('passed','failed','inconclusive_infrastructure','not_applicable')),
	CONSTRAINT "design_adapter_conformance_runs_artifact_digest_check" CHECK ("design_adapter_conformance_runs"."artifact_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_adapter_conformance_runs_receipt_digest_check" CHECK ("design_adapter_conformance_runs"."receipt_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_adapter_conformance_runs_passed_requires_receipt_check" CHECK (("design_adapter_conformance_runs"."outcome" = 'passed' AND "design_adapter_conformance_runs"."receipt" IS NOT NULL AND "design_adapter_conformance_runs"."adapter_version" <> '') OR ("design_adapter_conformance_runs"."outcome" <> 'passed'))
);
--> statement-breakpoint
ALTER TABLE "design_adapter_conformance_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_adapter_conformance_runs" ADD CONSTRAINT "design_adapter_conformance_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_adapter_conformance_runs" ADD CONSTRAINT "design_adapter_conformance_runs_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_adapter_conformance_runs" ADD CONSTRAINT "design_adapter_conformance_runs_release_fk" FOREIGN KEY ("org_id","release_id") REFERENCES "public"."design_system_releases"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_adapter_conformance_runs" ADD CONSTRAINT "design_adapter_conformance_runs_artifact_fk" FOREIGN KEY ("org_id","artifact_id") REFERENCES "public"."design_artifacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_adapter_conformance_runs_org_id" ON "design_adapter_conformance_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "design_adapter_conformance_runs_org_project" ON "design_adapter_conformance_runs" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "design_adapter_conformance_runs_org_project_target" ON "design_adapter_conformance_runs" USING btree ("org_id","project_id","target");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_adapter_conformance_runs" AS PERMISSIVE FOR ALL TO public USING ("design_adapter_conformance_runs"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_adapter_conformance_runs"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
ALTER TABLE "design_adapter_conformance_runs" FORCE ROW LEVEL SECURITY;
