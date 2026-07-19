CREATE TABLE "behavior_flake_quarantines" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"id" text NOT NULL,
	"behavior_revision_id" text NOT NULL,
	"transition" text NOT NULL,
	"gate_effect" text NOT NULL,
	"classification" text NOT NULL,
	"reason" text NOT NULL,
	"actor" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "behavior_flake_quarantines_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "behavior_flake_quarantines_transition_check" CHECK ("behavior_flake_quarantines"."transition" IN ('quarantine','release')),
	CONSTRAINT "behavior_flake_quarantines_gate_effect_check" CHECK ("behavior_flake_quarantines"."gate_effect" IN ('excluded_from_green','restored')),
	CONSTRAINT "behavior_flake_quarantines_classification_check" CHECK ("behavior_flake_quarantines"."classification" IN ('flaky','consistent_failure','stable','insufficient_observation')),
	CONSTRAINT "behavior_flake_quarantines_context_hash_check" CHECK ("behavior_flake_quarantines"."context_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "behavior_flake_quarantines_transition_shape_check" CHECK ((
        "behavior_flake_quarantines"."transition" = 'quarantine'
          AND "behavior_flake_quarantines"."gate_effect" = 'excluded_from_green'
          AND "behavior_flake_quarantines"."classification" = 'flaky'
      ) OR (
        "behavior_flake_quarantines"."transition" = 'release'
          AND "behavior_flake_quarantines"."gate_effect" = 'restored'
      ))
);
--> statement-breakpoint
ALTER TABLE "behavior_flake_quarantines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "behavior_flake_quarantines" ADD CONSTRAINT "behavior_flake_quarantines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behavior_flake_quarantines" ADD CONSTRAINT "behavior_flake_quarantines_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "behavior_flake_quarantines_org_id" ON "behavior_flake_quarantines" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "behavior_flake_quarantines_behavior" ON "behavior_flake_quarantines" USING btree ("org_id","project_id","behavior_revision_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "behavior_flake_quarantines" AS PERMISSIVE FOR ALL TO public USING ("behavior_flake_quarantines"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("behavior_flake_quarantines"."org_id" = current_setting('app.current_org_id', true));
--> statement-breakpoint
ALTER TABLE "behavior_flake_quarantines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Append-only governance ledger: a quarantine / release transition is a sealed record —
-- never mutated or deleted. Un-quarantine is a NEW `release` row, not an edit. This makes
-- the who/why/when trail tamper-evident and forbids silently flipping a quarantine's
-- gate_effect after the fact (mirrors 0079/0083).
CREATE FUNCTION "enforce_behavior_flake_quarantines_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'behavior_flake_quarantines rows are immutable (append-only): % rejected', TG_OP;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "behavior_flake_quarantines_immutable"
BEFORE UPDATE OR DELETE ON "behavior_flake_quarantines"
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_flake_quarantines_immutable"();
