-- Wave-6 rv-8 barrier: reshape the 0037 behavior-effect backing table into the
-- append-only observer evidence contract without discarding its legacy attempt link.
ALTER TABLE "behavior_effect_observations" RENAME COLUMN "id" TO "observation_id";
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" RENAME COLUMN "observer_provider" TO "observer";
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" RENAME COLUMN "cursor_watermark" TO "cursor";
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" RENAME COLUMN "duplicate_classification" TO "classification";
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ALTER COLUMN "attempt_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ALTER COLUMN "trigger_id_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ALTER COLUMN "provider_object_hash" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ALTER COLUMN "cursor" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ALTER COLUMN "occurrence_count" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ADD COLUMN "provider" text;
--> statement-breakpoint
UPDATE "behavior_effect_observations" SET "provider" = 'legacy' WHERE "provider" IS NULL;
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ALTER COLUMN "provider" SET NOT NULL;
--> statement-breakpoint
UPDATE "behavior_effect_observations" SET "classification" = 'ok' WHERE "classification" = 'unique';
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" DROP CONSTRAINT "behavior_effect_observations_duplicate_check";
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ADD CONSTRAINT "behavior_effect_observations_classification_check" CHECK ("behavior_effect_observations"."classification" IN ('ok','missing','duplicate'));
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ADD CONSTRAINT "behavior_effect_observations_trigger_id_hash_check" CHECK ("behavior_effect_observations"."trigger_id_hash" ~ '^sha256:[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ADD CONSTRAINT "behavior_effect_observations_provider_object_hash_check" CHECK ("behavior_effect_observations"."provider_object_hash" ~ '^sha256:[0-9a-f]{64}$');
--> statement-breakpoint
CREATE TABLE "effect_observer_watermarks" (
  "org_id" text NOT NULL,
  "project_id" text NOT NULL,
  "observer" text NOT NULL,
  "watermark" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "effect_observer_watermarks_org_id_project_id_observer_pk" PRIMARY KEY("org_id","project_id","observer")
);
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "effect_observer_watermarks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "effect_observer_watermarks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE UNIQUE INDEX "behavior_effect_observations_org_project_observation_id_unique" ON "behavior_effect_observations" USING btree ("org_id","project_id","observation_id");
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" DROP CONSTRAINT "behavior_effect_observations_project_fk";
--> statement-breakpoint
ALTER TABLE "behavior_effect_observations" ADD CONSTRAINT "behavior_effect_observations_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "effect_observer_watermarks" ADD CONSTRAINT "effect_observer_watermarks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "effect_observer_watermarks" ADD CONSTRAINT "effect_observer_watermarks_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "behavior_effect_observations";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "behavior_effect_observations" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON "effect_observer_watermarks";
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON "effect_observer_watermarks" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint
CREATE FUNCTION "enforce_behavior_effect_observations_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'behavior_effect_observations rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "behavior_effect_observations_immutable"
BEFORE UPDATE OR DELETE ON "behavior_effect_observations"
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_effect_observations_immutable"();
