ALTER TABLE "policy_bindings" ADD COLUMN "is_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
WITH ranked_bindings AS (
  SELECT org_id, id,
         row_number() OVER (PARTITION BY org_id, project_id ORDER BY created_at DESC, id DESC) AS position
    FROM policy_bindings
)
UPDATE policy_bindings AS binding
   SET is_active = true
  FROM ranked_bindings AS ranked
 WHERE binding.org_id = ranked.org_id
   AND binding.id = ranked.id
   AND ranked.position = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "policy_bindings_one_active_per_project" ON "policy_bindings" USING btree ("org_id","project_id") WHERE "policy_bindings"."is_active";
