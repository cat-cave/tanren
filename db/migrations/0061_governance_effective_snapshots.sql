CREATE TABLE "effective_policy_snapshots" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"tier_id" text NOT NULL,
	"policy_revision_id" text NOT NULL,
	"effective_policy_hash" text NOT NULL,
	"compiled_body" jsonb NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"inputs_digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "effective_policy_snapshots_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "effective_policy_snapshots_effective_policy_hash_check" CHECK ("effective_policy_snapshots"."effective_policy_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "effective_policy_snapshots_subject_kind_check" CHECK ("effective_policy_snapshots"."subject_kind" IN ('run','change','activation'))
);
--> statement-breakpoint
ALTER TABLE "effective_policy_snapshots" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "effective_policy_snapshots" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "effective_policy_snapshots" ADD CONSTRAINT "effective_policy_snapshots_binding_fk" FOREIGN KEY ("org_id","binding_id") REFERENCES "public"."policy_bindings"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effective_policy_snapshots" ADD CONSTRAINT "effective_policy_snapshots_policy_revision_fk" FOREIGN KEY ("org_id","policy_revision_id") REFERENCES "public"."governance_policy_revisions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "effective_policy_snapshots";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "effective_policy_snapshots" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE FUNCTION "reject_effective_policy_snapshot_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'effective_policy_snapshots is append-only; % is not permitted', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "effective_policy_snapshots_append_only"
BEFORE UPDATE OR DELETE ON "effective_policy_snapshots"
FOR EACH ROW EXECUTE FUNCTION "reject_effective_policy_snapshot_mutation"();
