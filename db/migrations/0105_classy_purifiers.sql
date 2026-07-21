CREATE TABLE "design_external_imports" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"source" text NOT NULL,
	"locator" text NOT NULL,
	"external_revision" text NOT NULL,
	"snapshot_digest" text NOT NULL,
	"receipt_digest" text NOT NULL,
	"receipt" jsonb NOT NULL,
	"disposition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_external_imports_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_external_imports_source_check" CHECK ("design_external_imports"."source" IN ('figma','registry')),
	CONSTRAINT "design_external_imports_disposition_check" CHECK ("design_external_imports"."disposition" IN ('quarantined','candidate','rejected')),
	CONSTRAINT "design_external_imports_snapshot_digest_check" CHECK ("design_external_imports"."snapshot_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_external_imports_receipt_digest_check" CHECK ("design_external_imports"."receipt_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_external_imports_locator_nonblank_check" CHECK (btrim("design_external_imports"."locator") <> ''),
	CONSTRAINT "design_external_imports_revision_nonblank_check" CHECK (btrim("design_external_imports"."external_revision") <> '')
);
--> statement-breakpoint
ALTER TABLE "design_external_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "design_imports" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"publication_id" text NOT NULL,
	"source_release_digest" text NOT NULL,
	"design_system_id" text NOT NULL,
	"release_id" text NOT NULL,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_policy" text NOT NULL,
	"last_seen_upstream" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_imports_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_imports_release_digest_check" CHECK ("design_imports"."source_release_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_imports_sync_policy_check" CHECK ("design_imports"."sync_policy" IN ('immutable_fork','manual_sync')),
	CONSTRAINT "design_imports_upstream_nonblank_check" CHECK (btrim("design_imports"."last_seen_upstream") <> '')
);
--> statement-breakpoint
ALTER TABLE "design_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "design_share_links" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"publication_id" text NOT NULL,
	"source_release_id" text NOT NULL,
	"source_release_digest" text NOT NULL,
	"recipient_org_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"permission" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"redemption_count" integer DEFAULT 0 NOT NULL,
	"redemption_limit" integer NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_share_links_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_share_links_release_digest_check" CHECK ("design_share_links"."source_release_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_share_links_token_hash_check" CHECK ("design_share_links"."token_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_share_links_permission_check" CHECK ("design_share_links"."permission" IN ('import','fork')),
	CONSTRAINT "design_share_links_count_check" CHECK ("design_share_links"."redemption_count" >= 0 AND "design_share_links"."redemption_limit" > 0 AND "design_share_links"."redemption_count" <= "design_share_links"."redemption_limit")
);
--> statement-breakpoint
ALTER TABLE "design_share_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "design_system_grants" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"publication_id" text NOT NULL,
	"allowed_release_digest" text NOT NULL,
	"capability" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"import_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_system_grants_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "design_system_grants_release_digest_check" CHECK ("design_system_grants"."allowed_release_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "design_system_grants_capability_check" CHECK ("design_system_grants"."capability" IN ('import','fork'))
);
--> statement-breakpoint
ALTER TABLE "design_system_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "published_design_system_releases" (
	"publication_id" text PRIMARY KEY NOT NULL,
	"public_slug" text NOT NULL,
	"source_release_digest" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"safe_preview_digest" text NOT NULL,
	"license" text NOT NULL,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "published_design_system_releases_state_check" CHECK ("published_design_system_releases"."state" IN ('published','revoked')),
	CONSTRAINT "published_design_system_releases_release_digest_check" CHECK ("published_design_system_releases"."source_release_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "published_design_system_releases_manifest_digest_check" CHECK ("published_design_system_releases"."manifest_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "published_design_system_releases_preview_digest_check" CHECK ("published_design_system_releases"."safe_preview_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "published_design_system_releases_slug_nonblank_check" CHECK (btrim("published_design_system_releases"."public_slug") <> ''),
	CONSTRAINT "published_design_system_releases_license_nonblank_check" CHECK (btrim("published_design_system_releases"."license") <> ''),
	CONSTRAINT "published_design_system_releases_revocation_state_check" CHECK (("published_design_system_releases"."state" = 'published' AND "published_design_system_releases"."revoked_at" IS NULL) OR ("published_design_system_releases"."state" = 'revoked' AND "published_design_system_releases"."revoked_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "published_design_system_releases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_external_imports" ADD CONSTRAINT "design_external_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_imports" ADD CONSTRAINT "design_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_imports" ADD CONSTRAINT "design_imports_publication_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."published_design_system_releases"("publication_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_imports" ADD CONSTRAINT "design_imports_system_fk" FOREIGN KEY ("org_id","design_system_id") REFERENCES "public"."design_systems"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_imports" ADD CONSTRAINT "design_imports_release_fk" FOREIGN KEY ("org_id","release_id") REFERENCES "public"."design_system_releases"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_share_links" ADD CONSTRAINT "design_share_links_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_share_links" ADD CONSTRAINT "design_share_links_recipient_org_id_organizations_id_fk" FOREIGN KEY ("recipient_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_share_links" ADD CONSTRAINT "design_share_links_publication_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."published_design_system_releases"("publication_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_share_links" ADD CONSTRAINT "design_share_links_source_release_fk" FOREIGN KEY ("org_id","source_release_id") REFERENCES "public"."design_system_releases"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_system_grants" ADD CONSTRAINT "design_system_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_system_grants" ADD CONSTRAINT "design_system_grants_publication_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."published_design_system_releases"("publication_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_external_imports_org_id" ON "design_external_imports" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_external_imports_org_source_locator_revision_unique" ON "design_external_imports" USING btree ("org_id","source","locator","external_revision");--> statement-breakpoint
CREATE INDEX "design_imports_org_id" ON "design_imports" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_imports_org_publication_unique" ON "design_imports" USING btree ("org_id","publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_share_links_token_hash_unique" ON "design_share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "design_share_links_org_id" ON "design_share_links" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "design_share_links_recipient_org" ON "design_share_links" USING btree ("recipient_org_id");--> statement-breakpoint
CREATE INDEX "design_system_grants_org_id" ON "design_system_grants" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_system_grants_org_publication_unique" ON "design_system_grants" USING btree ("org_id","publication_id");--> statement-breakpoint
CREATE UNIQUE INDEX "design_system_grants_org_idempotency_unique" ON "design_system_grants" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "published_design_system_releases_public_slug_unique" ON "published_design_system_releases" USING btree ("public_slug");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_external_imports" AS PERMISSIVE FOR ALL TO public USING ("design_external_imports"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_external_imports"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_imports" AS PERMISSIVE FOR ALL TO public USING ("design_imports"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_imports"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_share_links" AS PERMISSIVE FOR ALL TO public USING ("design_share_links"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_share_links"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "design_system_grants" AS PERMISSIVE FOR ALL TO public USING ("design_system_grants"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("design_system_grants"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "published_design_system_releases_public_read" ON "published_design_system_releases" AS PERMISSIVE FOR SELECT TO public USING ("published_design_system_releases"."state" = 'published' AND "published_design_system_releases"."revoked_at" IS NULL);--> statement-breakpoint
ALTER TABLE "published_design_system_releases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_share_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_system_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_imports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "design_external_imports" FORCE ROW LEVEL SECURITY;
