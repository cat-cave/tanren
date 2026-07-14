-- SP-4 · slot 0039 — the Authority pattern's durable substrate (MergeAuthorityV2).
-- The immutable land decision + the idempotent 4-step land protocol tables. Reconciliation
-- rule 1/3: authority_decisions (NOT the legacy 'merge_authority_decisions' name) uses a
-- SCALAR integration_node_id identity column (NO forward FK to the feature integration_nodes
-- table). All digest columns carry the ^sha256:[0-9a-f]{64}$ CHECK. FKs are backward-only
-- (organizations, projects, and within this band decision←intent←receipt/reconcile).

CREATE TABLE "authority_decisions" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"integration_node_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"head_sha" text NOT NULL,
	"expected_main_sha" text NOT NULL,
	"artifact_digest" text NOT NULL,
	"proof_root" text NOT NULL,
	"member_set_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"decision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authority_decisions_subject_kind_check" CHECK ("authority_decisions"."subject_kind" IN ('integration_node')),
	CONSTRAINT "authority_decisions_decision_check" CHECK ("authority_decisions"."decision" IN ('authorized', 'blocked', 'needs_attention')),
	CONSTRAINT "authority_decisions_artifact_digest_check" CHECK ("authority_decisions"."artifact_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "authority_decisions_proof_root_check" CHECK ("authority_decisions"."proof_root" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "authority_decisions_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "authority_decisions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "authority_decisions_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "authority_decisions_org_id" ON "authority_decisions" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "authority_decisions_org_project" ON "authority_decisions" USING btree ("org_id", "project_id");
--> statement-breakpoint
CREATE INDEX "authority_decisions_org_node" ON "authority_decisions" USING btree ("org_id", "integration_node_id");
--> statement-breakpoint
ALTER TABLE "authority_decisions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "authority_decisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "authority_decisions";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "authority_decisions" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "authority_effect_intents" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"decision_id" text NOT NULL,
	"integration_node_id" text NOT NULL,
	"into_main" text NOT NULL,
	"authorized_sha" text NOT NULL,
	"expected_main_sha" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authority_effect_intents_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "authority_effect_intents_org_idem_unique" UNIQUE ("org_id", "idempotency_key"),
	CONSTRAINT "authority_effect_intents_decision_fk" FOREIGN KEY ("org_id", "decision_id") REFERENCES "authority_decisions"("org_id", "id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "authority_effect_intents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "authority_effect_intents_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "authority_effect_intents_org_id" ON "authority_effect_intents" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "authority_effect_intents_org_project" ON "authority_effect_intents" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "authority_effect_intents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "authority_effect_intents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "authority_effect_intents";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "authority_effect_intents" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "authority_land_receipts" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"effect_intent_id" text NOT NULL,
	"main_sha" text NOT NULL,
	"audit_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authority_land_receipts_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "authority_land_receipts_org_intent_unique" UNIQUE ("org_id", "effect_intent_id"),
	CONSTRAINT "authority_land_receipts_intent_fk" FOREIGN KEY ("org_id", "effect_intent_id") REFERENCES "authority_effect_intents"("org_id", "id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "authority_land_receipts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "authority_land_receipts_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "authority_land_receipts_org_id" ON "authority_land_receipts" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "authority_land_receipts_org_project" ON "authority_land_receipts" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "authority_land_receipts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "authority_land_receipts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "authority_land_receipts";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "authority_land_receipts" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE TABLE "authority_effect_reconciles" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"effect_intent_id" text NOT NULL,
	"state" text NOT NULL,
	"reason" text,
	"main_sha" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authority_effect_reconciles_state_check" CHECK ("authority_effect_reconciles"."state" IN ('landed', 'not_landed', 'state_unknown')),
	CONSTRAINT "authority_effect_reconciles_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "authority_effect_reconciles_intent_fk" FOREIGN KEY ("org_id", "effect_intent_id") REFERENCES "authority_effect_intents"("org_id", "id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "authority_effect_reconciles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "authority_effect_reconciles_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "authority_effect_reconciles_org_id" ON "authority_effect_reconciles" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "authority_effect_reconciles_org_project" ON "authority_effect_reconciles" USING btree ("org_id", "project_id");
--> statement-breakpoint
ALTER TABLE "authority_effect_reconciles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "authority_effect_reconciles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "authority_effect_reconciles";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "authority_effect_reconciles" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
