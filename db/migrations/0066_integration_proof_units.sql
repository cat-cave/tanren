-- Wave-6 mq-6 barrier: immutable granular proof units, their DAG edges, and evaluations.
CREATE TABLE "integration_proof_units" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "proof_unit_id" text NOT NULL,
  "kind" text NOT NULL,
  "subject_id" text NOT NULL,
  "input_hash" text,
  "verdict" text NOT NULL,
  "artifact_hash" text,
  "source_node_id" text,
  "quarantine_epoch" integer DEFAULT 0 NOT NULL,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "integration_proof_units_org_id_proof_unit_id_pk" PRIMARY KEY("org_id","proof_unit_id"),
  CONSTRAINT "integration_proof_units_input_hash_check" CHECK ("integration_proof_units"."input_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "integration_proof_units_artifact_hash_check" CHECK ("integration_proof_units"."artifact_hash" ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT "integration_proof_units_verdict_check" CHECK ("integration_proof_units"."verdict" IN ('pass','fail','skipped'))
);
--> statement-breakpoint
CREATE TABLE "integration_proof_edges" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "parent_unit_id" text NOT NULL,
  "child_unit_id" text NOT NULL,
  CONSTRAINT "integration_proof_edges_org_id_parent_unit_id_child_unit_id_pk" PRIMARY KEY("org_id","parent_unit_id","child_unit_id")
);
--> statement-breakpoint
CREATE TABLE "integration_evaluation_proofs" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "evaluation_id" text NOT NULL,
  "proof_unit_id" text NOT NULL,
  CONSTRAINT "integration_evaluation_proofs_org_id_evaluation_id_proof_unit_id_pk" PRIMARY KEY("org_id","evaluation_id","proof_unit_id")
);
--> statement-breakpoint
ALTER TABLE "integration_proof_units" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration_proof_units" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration_proof_edges" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration_proof_edges" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration_evaluation_proofs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "integration_evaluation_proofs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "integration_proof_units_org_project_proof_unit_id_unique" ON "integration_proof_units" USING btree ("org_id","project_id","proof_unit_id");
--> statement-breakpoint
CREATE INDEX "integration_proof_units_org_id" ON "integration_proof_units" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "integration_proof_units" ADD CONSTRAINT "integration_proof_units_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_proof_units" ADD CONSTRAINT "integration_proof_units_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_proof_edges" ADD CONSTRAINT "integration_proof_edges_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_proof_edges" ADD CONSTRAINT "integration_proof_edges_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_proof_edges" ADD CONSTRAINT "integration_proof_edges_parent_unit_fk" FOREIGN KEY ("org_id","parent_unit_id") REFERENCES "public"."integration_proof_units"("org_id","proof_unit_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_proof_edges" ADD CONSTRAINT "integration_proof_edges_child_unit_fk" FOREIGN KEY ("org_id","child_unit_id") REFERENCES "public"."integration_proof_units"("org_id","proof_unit_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_evaluation_proofs" ADD CONSTRAINT "integration_evaluation_proofs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_evaluation_proofs" ADD CONSTRAINT "integration_evaluation_proofs_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "integration_evaluation_proofs" ADD CONSTRAINT "integration_evaluation_proofs_proof_unit_fk" FOREIGN KEY ("org_id","proof_unit_id") REFERENCES "public"."integration_proof_units"("org_id","proof_unit_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "integration_proof_units";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "integration_proof_units" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "integration_proof_edges";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "integration_proof_edges" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "integration_evaluation_proofs";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "integration_evaluation_proofs" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE FUNCTION "enforce_integration_proof_units_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'integration_proof_units rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "integration_proof_units_immutable"
BEFORE UPDATE OR DELETE ON "integration_proof_units"
FOR EACH ROW EXECUTE FUNCTION "enforce_integration_proof_units_immutable"();
--> statement-breakpoint
CREATE FUNCTION "enforce_integration_proof_edges_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'integration_proof_edges rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "integration_proof_edges_immutable"
BEFORE UPDATE OR DELETE ON "integration_proof_edges"
FOR EACH ROW EXECUTE FUNCTION "enforce_integration_proof_edges_immutable"();
--> statement-breakpoint
CREATE FUNCTION "enforce_integration_evaluation_proofs_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'integration_evaluation_proofs rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "integration_evaluation_proofs_immutable"
BEFORE UPDATE OR DELETE ON "integration_evaluation_proofs"
FOR EACH ROW EXECUTE FUNCTION "enforce_integration_evaluation_proofs_immutable"();
--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD COLUMN "proof_root" text;
--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD COLUMN "quarantine_epoch" integer;
--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD COLUMN "toolchain_hash" text;
--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD COLUMN "design_contract_version" text;
--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD COLUMN "behavior_manifest_hash" text;
