CREATE TABLE "merge_repair_routes" (
	"org_id" text NOT NULL,
	"route_id" text NOT NULL,
	"project_id" text NOT NULL,
	"source_spec_id" text NOT NULL,
	"group_id" text NOT NULL,
	"evaluation_id" text NOT NULL,
	"disposition" text NOT NULL,
	"failure_class" text NOT NULL,
	"failure_signature" text NOT NULL,
	"magnitude" integer NOT NULL,
	"finding_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"reason_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"respec_generation" integer DEFAULT 0 NOT NULL,
	"prior_agent_route" text,
	"next_agent_route" text,
	"packet_hash" text,
	"replacement_spec_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_repair_routes_org_id_route_id_pk" PRIMARY KEY("org_id","route_id"),
	CONSTRAINT "merge_repair_routes_disposition_check" CHECK ("merge_repair_routes"."disposition" IN ('repair_in_place','respec','blocked_needs_attention')),
	CONSTRAINT "merge_repair_routes_respec_lineage_check" CHECK (("merge_repair_routes"."disposition" = 'respec') = ("merge_repair_routes"."packet_hash" IS NOT NULL AND "merge_repair_routes"."prior_agent_route" IS NOT NULL AND "merge_repair_routes"."next_agent_route" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "merge_repair_routes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merge_repair_routes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "merge_repair_routes" ADD CONSTRAINT "merge_repair_routes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_repair_routes" ADD CONSTRAINT "merge_repair_routes_spec_lineage_fk" FOREIGN KEY ("org_id","project_id","source_spec_id") REFERENCES "public"."specs"("org_id","project_id","spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_repair_routes" ADD CONSTRAINT "merge_repair_routes_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merge_repair_routes_spec_history" ON "merge_repair_routes" USING btree ("org_id","project_id","source_spec_id","created_at");--> statement-breakpoint
CREATE INDEX "merge_repair_routes_org_id" ON "merge_repair_routes" USING btree ("org_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "merge_repair_routes" AS PERMISSIVE FOR ALL TO public USING ("merge_repair_routes"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("merge_repair_routes"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
-- mq-10 event-vocabulary seed: register the router's event names before it emits them
-- (mirrors the generated db/src/eventTypesSeed.ts catalog; the events FK requires them).
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('merge.repair.routed', 'warn'),
  ('merge.member.respec_routed', 'warn')
ON CONFLICT ("name") DO NOTHING;
