CREATE TABLE "design_artifact_files" (
	"org_id" text NOT NULL,
	"artifact_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"media_type" text NOT NULL,
	"digest" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"executable" boolean DEFAULT false NOT NULL,
	CONSTRAINT "design_artifact_files_org_id_artifact_id_path_pk" PRIMARY KEY("org_id","artifact_id","path"),
	CONSTRAINT "design_artifact_files_digest_check" CHECK ("design_artifact_files"."digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_artifact_files_byte_size_check" CHECK ("design_artifact_files"."byte_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "design_artifact_files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "design_artifacts" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"design_system_id" text,
	"digest" text NOT NULL,
	"media_type" text NOT NULL,
	"manifest_version" integer NOT NULL,
	"object_store_key" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"encryption_key_ref" text,
	"retention_class" text DEFAULT 'standard' NOT NULL,
	"quarantined" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_artifacts_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_artifacts_digest_check" CHECK ("design_artifacts"."digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_artifacts_manifest_version_check" CHECK ("design_artifacts"."manifest_version" >= 1),
	CONSTRAINT "design_artifacts_byte_size_check" CHECK ("design_artifacts"."byte_size" >= 0),
	CONSTRAINT "design_artifacts_retention_check" CHECK ("design_artifacts"."retention_class" IN ('ephemeral','standard','durable'))
);
--> statement-breakpoint
ALTER TABLE "design_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "design_release_channels" (
	"org_id" text NOT NULL,
	"design_system_id" text NOT NULL,
	"channel" text NOT NULL,
	"release_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_release_channels_org_id_design_system_id_channel_pk" PRIMARY KEY("org_id","design_system_id","channel")
);
--> statement-breakpoint
ALTER TABLE "design_release_channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "design_system_releases" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"design_system_id" text NOT NULL,
	"version" integer NOT NULL,
	"parent_release_id" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"contract_id" text NOT NULL,
	"contract_version" integer NOT NULL,
	"contract_digest" text NOT NULL,
	"manifest_schema_version" integer NOT NULL,
	"canonical_artifact_id" text,
	"compatibility_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "design_system_releases_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_system_releases_version_check" CHECK ("design_system_releases"."version" >= 1),
	CONSTRAINT "design_system_releases_contract_version_check" CHECK ("design_system_releases"."contract_version" >= 1),
	CONSTRAINT "design_system_releases_manifest_version_check" CHECK ("design_system_releases"."manifest_schema_version" >= 1),
	CONSTRAINT "design_system_releases_contract_digest_check" CHECK ("design_system_releases"."contract_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_system_releases_state_check" CHECK ("design_system_releases"."state" IN ('draft','validated','published','deprecated','quarantined')),
	CONSTRAINT "design_system_releases_published_check" CHECK (("design_system_releases"."state" IN ('published','deprecated') AND "design_system_releases"."published_at" IS NOT NULL AND "design_system_releases"."published_by" IS NOT NULL AND "design_system_releases"."canonical_artifact_id" IS NOT NULL) OR ("design_system_releases"."state" IN ('draft','validated','quarantined') AND "design_system_releases"."published_at" IS NULL AND "design_system_releases"."published_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "design_system_releases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "design_systems" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"lifecycle" text DEFAULT 'draft' NOT NULL,
	"default_channel" text DEFAULT 'stable' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_systems_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_systems_lifecycle_check" CHECK ("design_systems"."lifecycle" IN ('draft','active','archived'))
);
--> statement-breakpoint
ALTER TABLE "design_systems" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_artifact_files" ADD CONSTRAINT "design_artifact_files_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_artifact_files" ADD CONSTRAINT "design_artifact_files_artifact_fk" FOREIGN KEY ("org_id","artifact_id") REFERENCES "public"."design_artifacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_artifacts" ADD CONSTRAINT "design_artifacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_artifacts" ADD CONSTRAINT "design_artifacts_system_fk" FOREIGN KEY ("org_id","design_system_id") REFERENCES "public"."design_systems"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_release_channels" ADD CONSTRAINT "design_release_channels_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_release_channels" ADD CONSTRAINT "design_release_channels_system_fk" FOREIGN KEY ("org_id","design_system_id") REFERENCES "public"."design_systems"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_release_channels" ADD CONSTRAINT "design_release_channels_release_fk" FOREIGN KEY ("org_id","release_id") REFERENCES "public"."design_system_releases"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_system_releases" ADD CONSTRAINT "design_system_releases_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_system_releases" ADD CONSTRAINT "design_system_releases_system_fk" FOREIGN KEY ("org_id","design_system_id") REFERENCES "public"."design_systems"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_system_releases" ADD CONSTRAINT "design_system_releases_artifact_fk" FOREIGN KEY ("org_id","canonical_artifact_id") REFERENCES "public"."design_artifacts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_system_releases" ADD CONSTRAINT "design_system_releases_parent_fk" FOREIGN KEY ("org_id","parent_release_id") REFERENCES "public"."design_system_releases"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_systems" ADD CONSTRAINT "design_systems_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_artifact_files_org_artifact" ON "design_artifact_files" USING btree ("org_id","artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_artifacts_org_id_unique" ON "design_artifacts" USING btree ("org_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_artifacts_org_digest_unique" ON "design_artifacts" USING btree ("org_id","digest");--> statement-breakpoint
CREATE INDEX "design_artifacts_org_id" ON "design_artifacts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "design_release_channels_org_id" ON "design_release_channels" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_system_releases_version_unique" ON "design_system_releases" USING btree ("org_id","design_system_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "design_system_releases_org_id_unique" ON "design_system_releases" USING btree ("org_id","id");--> statement-breakpoint
CREATE INDEX "design_system_releases_org_system" ON "design_system_releases" USING btree ("org_id","design_system_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_systems_org_slug_unique" ON "design_systems" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "design_systems_org_id" ON "design_systems" USING btree ("org_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_artifact_files" AS PERMISSIVE FOR ALL TO public USING ("design_artifact_files"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_artifact_files"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_artifacts" AS PERMISSIVE FOR ALL TO public USING ("design_artifacts"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_artifacts"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_release_channels" AS PERMISSIVE FOR ALL TO public USING ("design_release_channels"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_release_channels"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_system_releases" AS PERMISSIVE FOR ALL TO public USING ("design_system_releases"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_system_releases"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_systems" AS PERMISSIVE FOR ALL TO public USING ("design_systems"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_systems"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
-- ===========================================================================
-- FORCE ROW LEVEL SECURITY on every design-system table (mirrors migration
-- 0043): even the table OWNER is subject to the org-isolation policy, so a
-- privileged connection with no `app.current_org_id` GUC sees ZERO rows —
-- deny-by-default is not bypassable by the app role. Drizzle emits ENABLE +
-- the policy from `.enableRLS()`; FORCE is hand-appended here (not tracked in
-- the drizzle snapshot).
-- ===========================================================================
ALTER TABLE "design_systems" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_system_releases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_release_channels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_artifact_files" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- ===========================================================================
-- ds-0 DESIGN EVENT VOCABULARY FREEZE (SP-8 barrier, ds-0 owns its own wave).
-- Adds the design-system lifecycle event names ds-3..8 emit to the
-- platform-global `event_types` catalog BEFORE any consumer emits, so the
-- events.event_type FK domain covers every frozen name. Mirrors
-- db/src/eventTypesSeed.ts (regenerated from the Zod EventRegistry via
-- `codegen:events`). ON CONFLICT DO NOTHING keeps re-application idempotent
-- (matches migrations 0042/0046). Exact names from design bucket §7.
-- ===========================================================================
INSERT INTO "event_types" ("name", "default_severity") VALUES
  ('designFragment.authoring.attempt', 'info'),
  ('designFragment.authoring.failed', 'warn'),
  ('designFragment.authoring.started', 'info'),
  ('designFragment.authoring.succeeded', 'info'),
  ('designRender.scenario.recorded', 'info'),
  ('designSystem.artifact.validated', 'info'),
  ('designSystem.base.composed', 'info'),
  ('designSystem.binding.updated', 'info'),
  ('designSystem.candidate.composed', 'info'),
  ('designSystem.curation.started', 'info'),
  ('designSystem.fragment.missing', 'info'),
  ('designSystem.proof.reused', 'info'),
  ('designSystem.regression.bisected', 'warn'),
  ('designSystem.release.published', 'info')
ON CONFLICT ("name") DO NOTHING;
