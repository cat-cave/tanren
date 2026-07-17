-- Wave-4 mq-5 barrier: one authority decision can reconcile a durable land
-- group and each member's PR/run/spec outcome atomically at the control plane.
CREATE TABLE "land_groups" (
  "org_id" text NOT NULL,
  "id" text NOT NULL,
  "decision_id" text NOT NULL,
  "expected_main_sha" text NOT NULL,
  "authorized_sha" text NOT NULL,
  "state" text NOT NULL,
  "main_sha" text,
  "reconcile_token" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "land_groups_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
CREATE TABLE "land_group_members" (
  "org_id" text NOT NULL,
  "land_group_id" text NOT NULL,
  "member_key" text NOT NULL,
  "pr_number" text,
  "run_id" text,
  "spec_id" text,
  "outcome" text,
  CONSTRAINT "land_group_members_org_id_land_group_id_member_key_pk" PRIMARY KEY("org_id","land_group_id","member_key")
);
--> statement-breakpoint
ALTER TABLE "land_groups" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "land_groups" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "land_group_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "land_group_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX "land_groups_org_id" ON "land_groups" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "land_groups_org_decision" ON "land_groups" USING btree ("org_id","decision_id");
--> statement-breakpoint
CREATE INDEX "land_group_members_org_id" ON "land_group_members" USING btree ("org_id");
--> statement-breakpoint
CREATE INDEX "land_group_members_org_group" ON "land_group_members" USING btree ("org_id","land_group_id");
--> statement-breakpoint
ALTER TABLE "land_groups" ADD CONSTRAINT "land_groups_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "land_groups" ADD CONSTRAINT "land_groups_decision_fk" FOREIGN KEY ("org_id","decision_id") REFERENCES "public"."authority_decisions"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "land_group_members" ADD CONSTRAINT "land_group_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "land_group_members" ADD CONSTRAINT "land_group_members_land_group_fk" FOREIGN KEY ("org_id","land_group_id") REFERENCES "public"."land_groups"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "land_groups";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "land_groups" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "land_group_members";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "land_group_members" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
