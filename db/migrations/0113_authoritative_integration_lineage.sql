-- gv-17: Authoritative integration-node lineage.
-- Drizzle-generated CREATE TABLE / ENABLE RLS / composite FKs / policies, plus
-- hand-maintained FORCE RLS, policy re-assert (existing tables already had
-- baseline policies), and JSON→rows backfill.

CREATE TABLE "base_shift_operations" (
	"op_id" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"node_id" text,
	"dependent_run_id" text NOT NULL,
	"dependent_spec_id" text NOT NULL,
	"ancestor_spec_id" text,
	"from_base_sha" text NOT NULL,
	"to_base_sha" text NOT NULL,
	"from_member_key" text NOT NULL,
	"to_member_key" text NOT NULL,
	"from_members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"to_members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" text NOT NULL,
	"invalidation_cause" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_shift_operations_pk" PRIMARY KEY("org_id","op_id"),
	CONSTRAINT "base_shift_operations_decision_check" CHECK ("base_shift_operations"."decision" IN ('rebased_clean','rebased_resolved','replanned','held')),
	CONSTRAINT "base_shift_operations_cause_check" CHECK ("base_shift_operations"."invalidation_cause" IN ('ancestor_landed','base_moved','member_head_moved','stack_restack','policy_changed','proof_stale'))
);
--> statement-breakpoint
ALTER TABLE "base_shift_operations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_node_members" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"node_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"queue_id" text,
	"spec_id" text NOT NULL,
	"run_id" text NOT NULL,
	"branch" text NOT NULL,
	"head_sha" text NOT NULL,
	"included" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_node_members_pk" PRIMARY KEY("org_id","node_id","ordinal"),
	CONSTRAINT "integration_node_members_ordinal_check" CHECK ("integration_node_members"."ordinal" >= 0)
);
--> statement-breakpoint
ALTER TABLE "integration_node_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_nodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_proofs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "base_shift_operations" ADD CONSTRAINT "base_shift_operations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_shift_operations" ADD CONSTRAINT "base_shift_operations_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_shift_operations" ADD CONSTRAINT "base_shift_operations_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_shift_operations" ADD CONSTRAINT "base_shift_operations_node_fk" FOREIGN KEY ("org_id","node_id") REFERENCES "public"."integration_nodes"("org_id","node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_shift_operations" ADD CONSTRAINT "base_shift_operations_dependent_run_fk" FOREIGN KEY ("org_id","dependent_run_id") REFERENCES "public"."runs"("org_id","run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_shift_operations" ADD CONSTRAINT "base_shift_operations_dependent_spec_fk" FOREIGN KEY ("org_id","dependent_spec_id") REFERENCES "public"."specs"("org_id","spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_node_members" ADD CONSTRAINT "integration_node_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_node_members" ADD CONSTRAINT "integration_node_members_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_node_members" ADD CONSTRAINT "integration_node_members_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_node_members" ADD CONSTRAINT "integration_node_members_node_fk" FOREIGN KEY ("org_id","node_id") REFERENCES "public"."integration_nodes"("org_id","node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "base_shift_operations_org_project" ON "base_shift_operations" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "base_shift_operations_org_dependent_run" ON "base_shift_operations" USING btree ("org_id","dependent_run_id");--> statement-breakpoint
CREATE INDEX "base_shift_operations_org_node" ON "base_shift_operations" USING btree ("org_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_node_members_org_node_run_unique" ON "integration_node_members" USING btree ("org_id","node_id","run_id");--> statement-breakpoint
CREATE INDEX "integration_node_members_org_project" ON "integration_node_members" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "integration_node_members_org_node" ON "integration_node_members" USING btree ("org_id","node_id");--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD CONSTRAINT "integration_nodes_project_org_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_proofs" ADD CONSTRAINT "integration_proofs_project_org_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_proofs" ADD CONSTRAINT "integration_proofs_node_org_fk" FOREIGN KEY ("org_id","node_id") REFERENCES "public"."integration_nodes"("org_id","node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- FORCE RLS (baseline only ENABLE'd integration_nodes/proofs) + re-assert policies.
ALTER TABLE "integration_nodes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_proofs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_node_members" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "base_shift_operations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "rls_org_isolation" ON "integration_nodes";--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_nodes" AS PERMISSIVE FOR ALL TO public USING ("integration_nodes"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_nodes"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "rls_org_isolation" ON "integration_proofs";--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_proofs" AS PERMISSIVE FOR ALL TO public USING ("integration_proofs"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_proofs"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "rls_org_isolation" ON "base_shift_operations";--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "base_shift_operations" AS PERMISSIVE FOR ALL TO public USING ("base_shift_operations"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("base_shift_operations"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
DROP POLICY IF EXISTS "rls_org_isolation" ON "integration_node_members";--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_node_members" AS PERMISSIVE FOR ALL TO public USING ("integration_node_members"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_node_members"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
-- Backfill normalized members from the legacy JSON vector (camelCase keys).
--
-- The predicate is NODE-LEVEL ALL-OR-NOTHING, and every one of the four required fields is
-- checked for null-or-empty, for two fail-closed reasons:
--   1. `elem ? 'branch'` is TRUE for `{"branch": null}` (the KEY exists), and `->>` then
--      yields NULL into a NOT NULL column — the whole migration aborts. An empty string
--      passes the column but `decodeMembersStrict` rejects it, so the node would become
--      permanently unreadable (`loadAuthoritativeMembers` throws forever after).
--   2. Filtering only the BAD elements of an otherwise-good node would leave the member rows
--      and the JSON mirror disagreeing, which `sameOrderedMembers` treats as divergence — the
--      node fails closed for good. Skipping such a node WHOLE leaves it exactly as it was
--      (JSON-only, as before this migration) instead of half-migrated into a permanent error.
INSERT INTO "integration_node_members" (
  "org_id", "project_id", "node_id", "ordinal", "spec_id", "run_id", "branch", "head_sha", "included"
)
SELECT
  n."org_id",
  n."project_id",
  n."node_id",
  (ord.ordinality - 1)::integer AS "ordinal",
  elem ->> 'specId' AS "spec_id",
  elem ->> 'runId' AS "run_id",
  elem ->> 'branch' AS "branch",
  elem ->> 'headSha' AS "head_sha",
  true AS "included"
FROM "integration_nodes" n
CROSS JOIN LATERAL jsonb_array_elements(n."members") WITH ORDINALITY AS ord(elem, ordinality)
WHERE jsonb_typeof(n."members") = 'array'
  AND COALESCE(elem ->> 'specId', '') <> ''
  AND COALESCE(elem ->> 'runId', '') <> ''
  AND COALESCE(elem ->> 'branch', '') <> ''
  AND COALESCE(elem ->> 'headSha', '') <> ''
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(n."members") AS bad(elem)
    WHERE COALESCE(bad.elem ->> 'specId', '') = ''
       OR COALESCE(bad.elem ->> 'runId', '') = ''
       OR COALESCE(bad.elem ->> 'branch', '') = ''
       OR COALESCE(bad.elem ->> 'headSha', '') = ''
  )
ON CONFLICT DO NOTHING;
