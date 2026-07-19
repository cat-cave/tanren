CREATE TABLE "design_fragments" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"design_system_id" text,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"phase" text NOT NULL,
	"version" text NOT NULL,
	"digest" text NOT NULL,
	"target_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"persona_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"behavior_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conformance_suite_id" text NOT NULL,
	"body" jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'validated' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	CONSTRAINT "design_fragments_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_fragments_digest_check" CHECK ("design_fragments"."digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_fragments_status_check" CHECK ("design_fragments"."status" IN ('draft','validated')),
	CONSTRAINT "design_fragments_phase_check" CHECK ("design_fragments"."phase" IN ('base','primitive-tokens','semantic-tokens','component-tokens','theme-modes','typography-icons-assets','component-primitives','components','patterns-and-templates','motion-and-interaction','platform-binding','catalog-and-scenarios','exporters','postprocessors'))
);
--> statement-breakpoint
ALTER TABLE "design_fragments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_fragments" ADD CONSTRAINT "design_fragments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "design_fragments_org_klv_unique" ON "design_fragments" USING btree ("org_id","kind","label","version");--> statement-breakpoint
CREATE INDEX "design_fragments_org_kind_label" ON "design_fragments" USING btree ("org_id","kind","label");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_fragments" AS PERMISSIVE FOR ALL TO public USING ("design_fragments"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_fragments"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
-- ===========================================================================
-- FORCE ROW LEVEL SECURITY on the design-fragment registry (mirrors migrations
-- 0043 / 0050): even the table OWNER is subject to the org-isolation policy, so a
-- privileged connection with no `app.current_org_id` GUC sees ZERO rows —
-- deny-by-default is not bypassable by the app role. Drizzle emits ENABLE + the
-- policy from `.enableRLS()`; FORCE is hand-appended here (not tracked in the
-- drizzle snapshot).
-- ===========================================================================
ALTER TABLE "design_fragments" FORCE ROW LEVEL SECURITY;
