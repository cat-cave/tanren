CREATE TABLE "governance_policy_revisions" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"revision_number" integer NOT NULL,
	"schema_version" integer NOT NULL,
	"source_document" jsonb NOT NULL,
	"compiled_ast" jsonb NOT NULL,
	"policy_hash" text NOT NULL,
	"parent_revision_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "governance_policy_revisions_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "governance_policy_revisions_revision_number_check" CHECK ("governance_policy_revisions"."revision_number" >= 1),
	CONSTRAINT "governance_policy_revisions_schema_version_check" CHECK ("governance_policy_revisions"."schema_version" >= 1),
	CONSTRAINT "governance_policy_revisions_policy_hash_check" CHECK ("governance_policy_revisions"."policy_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "governance_policy_revisions_no_self_parent_check" CHECK ("governance_policy_revisions"."parent_revision_id" IS NULL OR "governance_policy_revisions"."parent_revision_id" <> "governance_policy_revisions"."id")
);
--> statement-breakpoint
ALTER TABLE "governance_policy_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "governance_policy_revisions" ADD CONSTRAINT "governance_policy_revisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_policy_revisions" ADD CONSTRAINT "governance_policy_revisions_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_policy_revisions" ADD CONSTRAINT "governance_policy_revisions_parent_fk" FOREIGN KEY ("org_id","parent_revision_id") REFERENCES "public"."governance_policy_revisions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "governance_policy_revisions_project_revision_unique" ON "governance_policy_revisions" USING btree ("org_id","project_id","revision_number");--> statement-breakpoint
CREATE INDEX "governance_policy_revisions_org_id" ON "governance_policy_revisions" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "governance_policy_revisions_org_project_hash" ON "governance_policy_revisions" USING btree ("org_id","project_id","policy_hash");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "governance_policy_revisions" AS PERMISSIVE FOR ALL TO public USING ("governance_policy_revisions"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("governance_policy_revisions"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
ALTER TABLE "governance_policy_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Append-only authority: a policy revision is immutable once written (activation
-- is a binding change, and a rollback is a NEW revision pointing at prior
-- content — never an in-place edit). Enforce it at the database, mirroring the
-- 0043 lineage-trigger style, so the immutability is provable and cannot be
-- bypassed by an errant writer.
CREATE FUNCTION "reject_governance_policy_revision_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'governance_policy_revisions is append-only; % is not permitted', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "governance_policy_revisions_append_only"
BEFORE UPDATE OR DELETE ON "governance_policy_revisions"
FOR EACH ROW EXECUTE FUNCTION "reject_governance_policy_revision_mutation"();
