CREATE TABLE "project_design_bindings" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"design_system_id" text NOT NULL,
	"pin_mode" text NOT NULL,
	"pinned_release_id" text,
	"channel" text,
	"bound_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_design_bindings_org_id_project_id_pk" PRIMARY KEY("org_id","project_id"),
	CONSTRAINT "project_design_bindings_pin_mode_check" CHECK ("project_design_bindings"."pin_mode" IN ('release','channel')),
	CONSTRAINT "project_design_bindings_pin_shape_check" CHECK (("project_design_bindings"."pin_mode" = 'release' AND "project_design_bindings"."pinned_release_id" IS NOT NULL AND "project_design_bindings"."channel" IS NULL) OR ("project_design_bindings"."pin_mode" = 'channel' AND "project_design_bindings"."channel" IS NOT NULL AND "project_design_bindings"."pinned_release_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "project_design_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_design_bindings" ADD CONSTRAINT "project_design_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_design_bindings" ADD CONSTRAINT "project_design_bindings_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_design_bindings" ADD CONSTRAINT "project_design_bindings_system_fk" FOREIGN KEY ("org_id","design_system_id") REFERENCES "public"."design_systems"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_design_bindings" ADD CONSTRAINT "project_design_bindings_release_fk" FOREIGN KEY ("org_id","pinned_release_id") REFERENCES "public"."design_system_releases"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_design_bindings_org_system" ON "project_design_bindings" USING btree ("org_id","design_system_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "project_design_bindings" AS PERMISSIVE FOR ALL TO public USING ("project_design_bindings"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("project_design_bindings"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
-- ===========================================================================
-- FORCE ROW LEVEL SECURITY on the ds-5 within-org reuse binding table (mirrors
-- migration 0050): even the table OWNER is subject to org isolation, so a
-- privileged connection with no `app.current_org_id` GUC sees ZERO rows. The
-- composite `(org_id, design_system_id)` / `(org_id, pinned_release_id)` FKs
-- already make another org's design system unreferenceable; FORCE RLS makes its
-- binding rows invisible. Drizzle emits ENABLE + the policy from `.enableRLS()`;
-- FORCE is hand-appended here (not tracked in the drizzle snapshot).
-- ===========================================================================
ALTER TABLE "project_design_bindings" FORCE ROW LEVEL SECURITY;
