-- Wave-3 barrier: immutable symptom contracts and their exact fragment composition.
CREATE TABLE "symptom_contracts" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "id" text NOT NULL,
  "issue_loop_id" text NOT NULL,
  "schema_version" integer NOT NULL,
  "contract_json" jsonb NOT NULL,
  "canonical_hash" text NOT NULL,
  "proof_policy" text,
  "target" jsonb,
  "source_revision" text,
  "author_task_id" text,
  "state" text NOT NULL,
  "baseline_required" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "symptom_contracts_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "symptom_contracts_canonical_hash_check" CHECK ("symptom_contracts"."canonical_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "symptom_contracts_state_check" CHECK ("symptom_contracts"."state" IN ('draft','authored','validated','superseded','authoring_failed'))
);
--> statement-breakpoint
CREATE TABLE "symptom_contract_fragments" (
  "org_id" text NOT NULL,
  "contract_id" text NOT NULL,
  "fragment_id" text NOT NULL,
  "version" integer NOT NULL,
  "content_hash" text NOT NULL,
  "conformance_result" text,
  CONSTRAINT "symptom_contract_fragments_org_id_contract_id_fragment_id_pk" PRIMARY KEY("org_id","contract_id","fragment_id"),
  CONSTRAINT "symptom_contract_fragments_content_hash_check" CHECK ("symptom_contract_fragments"."content_hash" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "symptom_contracts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "symptom_contracts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "symptom_contract_fragments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "symptom_contract_fragments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "symptom_contracts_org_project_id_unique" ON "symptom_contracts" USING btree ("org_id","project_id","id");
--> statement-breakpoint
CREATE INDEX "symptom_contracts_org_id" ON "symptom_contracts" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "symptom_contracts_org_loop" ON "symptom_contracts" USING btree ("org_id","issue_loop_id");
--> statement-breakpoint
CREATE INDEX "symptom_contract_fragments_org_id" ON "symptom_contract_fragments" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "symptom_contracts" ADD CONSTRAINT "symptom_contracts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "symptom_contracts" ADD CONSTRAINT "symptom_contracts_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "symptom_contracts" ADD CONSTRAINT "symptom_contracts_issue_loop_fk" FOREIGN KEY ("org_id","issue_loop_id") REFERENCES "public"."issue_loops"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "symptom_contract_fragments" ADD CONSTRAINT "symptom_contract_fragments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "symptom_contract_fragments" ADD CONSTRAINT "symptom_contract_fragments_contract_fk" FOREIGN KEY ("org_id","contract_id") REFERENCES "public"."symptom_contracts"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "symptom_contracts";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "symptom_contracts" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "symptom_contract_fragments";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "symptom_contract_fragments" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE FUNCTION "enforce_symptom_contracts_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'symptom_contracts rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "symptom_contracts_immutable"
BEFORE UPDATE OR DELETE ON "symptom_contracts"
FOR EACH ROW EXECUTE FUNCTION "enforce_symptom_contracts_immutable"();
