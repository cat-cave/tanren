-- Wave-3 barrier: partitioned merge scheduling and durable partition leases.
CREATE TABLE "merge_queue_partitions" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "id" text NOT NULL,
  "target_branch" text NOT NULL,
  "scope_key" text NOT NULL,
  "mode" text NOT NULL,
  "capacity" integer NOT NULL,
  "state" text NOT NULL,
  "generation" integer DEFAULT 0 NOT NULL,
  "pause_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "merge_queue_partitions_org_id_id_pk" PRIMARY KEY("org_id","id"),
  CONSTRAINT "merge_queue_partitions_mode_check" CHECK ("merge_queue_partitions"."mode" IN ('serial','scoped','isolated'))
);
--> statement-breakpoint
ALTER TABLE "merge_queue_partitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "merge_queue_partitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_partitions_project_target_scope_unique" ON "merge_queue_partitions" USING btree ("org_id","project_id","target_branch","scope_key");
--> statement-breakpoint
CREATE INDEX "merge_queue_partitions_org_id" ON "merge_queue_partitions" USING btree ("org_id");
--> statement-breakpoint
ALTER TABLE "merge_queue_partitions" ADD CONSTRAINT "merge_queue_partitions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "merge_queue_partitions" ADD CONSTRAINT "merge_queue_partitions_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "partition_id" text;
--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "lease_owner" text;
--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "lease_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "merge_queue" ADD COLUMN "scope_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_partition_fk" FOREIGN KEY ("org_id","partition_id") REFERENCES "public"."merge_queue_partitions"("org_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_lease_check" CHECK (("merge_queue"."lease_owner" IS NULL AND "merge_queue"."lease_expires_at" IS NULL) OR ("merge_queue"."lease_owner" IS NOT NULL AND "merge_queue"."lease_expires_at" IS NOT NULL));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "merge_queue_partitions";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "merge_queue_partitions" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
