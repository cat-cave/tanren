CREATE TABLE "behaviors" (
	"id" text PRIMARY KEY NOT NULL,
	"persona_id" text NOT NULL,
	"title" text NOT NULL,
	"given" text NOT NULL,
	"when" text NOT NULL,
	"then" text NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"label" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"order_index" integer NOT NULL,
	"eta" timestamp with time zone,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_status_check" CHECK ("milestones"."status" IN ('planned','in_flight','done','abandoned'))
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_scope_check" CHECK ("personas"."scope" IN ('org','project')),
	CONSTRAINT "personas_scope_project_check" CHECK (("personas"."scope" = 'org' AND "personas"."project_id" IS NULL) OR ("personas"."scope" = 'project' AND "personas"."project_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "spec_behaviors" (
	"spec_id" text NOT NULL,
	"behavior_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_behaviors_spec_id_behavior_id_pk" PRIMARY KEY("spec_id","behavior_id")
);
--> statement-breakpoint
CREATE TABLE "spec_dependencies" (
	"from_spec_id" text NOT NULL,
	"to_spec_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_dependencies_from_spec_id_to_spec_id_pk" PRIMARY KEY("from_spec_id","to_spec_id"),
	CONSTRAINT "spec_dependencies_no_self_loop" CHECK ("spec_dependencies"."from_spec_id" <> "spec_dependencies"."to_spec_id")
);
--> statement-breakpoint
CREATE TABLE "spec_milestones" (
	"spec_id" text NOT NULL,
	"milestone_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_milestones_spec_id_milestone_id_pk" PRIMARY KEY("spec_id","milestone_id")
);
--> statement-breakpoint
ALTER TABLE "behaviors" ADD CONSTRAINT "behaviors_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_behaviors" ADD CONSTRAINT "spec_behaviors_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_behaviors" ADD CONSTRAINT "spec_behaviors_behavior_id_behaviors_id_fk" FOREIGN KEY ("behavior_id") REFERENCES "public"."behaviors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_dependencies" ADD CONSTRAINT "spec_dependencies_from_spec_id_specs_spec_id_fk" FOREIGN KEY ("from_spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_dependencies" ADD CONSTRAINT "spec_dependencies_to_spec_id_specs_spec_id_fk" FOREIGN KEY ("to_spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_milestones" ADD CONSTRAINT "spec_milestones_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_milestones" ADD CONSTRAINT "spec_milestones_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "behaviors_persona_id" ON "behaviors" USING btree ("persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_project_label_unique" ON "milestones" USING btree ("project_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_project_order_unique" ON "milestones" USING btree ("project_id","order_index");--> statement-breakpoint
CREATE INDEX "personas_org_id" ON "personas" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "personas_project_id" ON "personas" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "spec_behaviors_behavior_id" ON "spec_behaviors" USING btree ("behavior_id");--> statement-breakpoint
CREATE INDEX "spec_dependencies_to_spec_id" ON "spec_dependencies" USING btree ("to_spec_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_milestones_spec_unique" ON "spec_milestones" USING btree ("spec_id");--> statement-breakpoint
CREATE INDEX "spec_milestones_milestone_id" ON "spec_milestones" USING btree ("milestone_id");--> statement-breakpoint
-- P2A-0018 default seed: for any spec row that has no spec_milestones row and
-- no spec_behaviors row after this migration, attach a per-project default
-- milestone ("M1 / Hello") and a per-project default persona + behavior
-- ("Developer · fixture operator" / "runs the fixture"). This keeps the
-- post-migration invariant that every spec has at least one milestone and at
-- least one behavior, without requiring an out-of-band seeder.
DO $$
DECLARE
  project_row RECORD;
  org_id_value TEXT;
  default_org_id TEXT;
  default_milestone_id TEXT;
  default_persona_id TEXT;
  default_behavior_id TEXT;
  unlinked_specs INT;
BEGIN
  FOR project_row IN
    SELECT DISTINCT p.project_id, p.org_id
    FROM projects p
    INNER JOIN specs s ON s.project_id = p.project_id
    WHERE NOT EXISTS (SELECT 1 FROM spec_milestones sm WHERE sm.spec_id = s.spec_id)
       OR NOT EXISTS (SELECT 1 FROM spec_behaviors sb WHERE sb.spec_id = s.spec_id)
  LOOP
    -- Each persona needs an org. If the project has no org_id yet (Phase 1
    -- legacy rows), conjure or reuse a single sentinel "default" org so the
    -- foreign key holds. P2A-0003 backfills real orgs separately.
    org_id_value := project_row.org_id;
    IF org_id_value IS NULL THEN
      SELECT id INTO default_org_id FROM organizations WHERE id = 'org_default_p2a_0018';
      IF default_org_id IS NULL THEN
        INSERT INTO organizations (id, kind, external_id, login, display_name)
        VALUES (
          'org_default_p2a_0018',
          'github_org',
          'p2a-0018-default',
          'p2a-0018-default',
          'Default org (P2A-0018 seed)'
        );
      END IF;
      org_id_value := 'org_default_p2a_0018';
    END IF;

    -- Default milestone per project
    SELECT m.id INTO default_milestone_id
    FROM milestones m
    WHERE m.project_id = project_row.project_id AND m.label = 'M1';
    IF default_milestone_id IS NULL THEN
      default_milestone_id := 'milestone_' || project_row.project_id || '_m1';
      INSERT INTO milestones (id, project_id, label, name, description, order_index, status)
      VALUES (default_milestone_id, project_row.project_id, 'M1', 'Hello', 'Default milestone seeded by P2A-0018', 0, 'planned');
    END IF;

    -- Default persona per project
    SELECT p.id INTO default_persona_id
    FROM personas p
    WHERE p.scope = 'project' AND p.project_id = project_row.project_id AND p.name = 'Developer · fixture operator';
    IF default_persona_id IS NULL THEN
      default_persona_id := 'persona_' || project_row.project_id || '_fixture_dev';
      INSERT INTO personas (id, scope, org_id, project_id, name, description)
      VALUES (
        default_persona_id,
        'project',
        org_id_value,
        project_row.project_id,
        'Developer · fixture operator',
        'Operator running the default Tanren fixture flow (seeded by P2A-0018).'
      );
    END IF;

    -- Default behavior owned by that persona
    SELECT b.id INTO default_behavior_id
    FROM behaviors b
    WHERE b.persona_id = default_persona_id AND b.title = 'runs the fixture';
    IF default_behavior_id IS NULL THEN
      default_behavior_id := 'behavior_' || project_row.project_id || '_runs_the_fixture';
      INSERT INTO behaviors (id, persona_id, title, given, "when", "then", description)
      VALUES (
        default_behavior_id,
        default_persona_id,
        'runs the fixture',
        'operator on a fresh stack',
        'they invoke the fixture flow',
        'the run completes end-to-end',
        'Default behavior seeded by P2A-0018 so every existing spec has at least one linked behavior.'
      );
    END IF;

    -- Link every unlinked spec in this project
    INSERT INTO spec_milestones (spec_id, milestone_id)
    SELECT s.spec_id, default_milestone_id
    FROM specs s
    WHERE s.project_id = project_row.project_id
      AND NOT EXISTS (SELECT 1 FROM spec_milestones sm WHERE sm.spec_id = s.spec_id);

    INSERT INTO spec_behaviors (spec_id, behavior_id)
    SELECT s.spec_id, default_behavior_id
    FROM specs s
    WHERE s.project_id = project_row.project_id
      AND NOT EXISTS (SELECT 1 FROM spec_behaviors sb WHERE sb.spec_id = s.spec_id);
  END LOOP;

  -- Post-condition: no spec without milestone or behavior. Fail the migration
  -- loudly if the invariant is violated rather than ship a corrupt schema.
  SELECT count(*) INTO unlinked_specs FROM specs s
  WHERE NOT EXISTS (SELECT 1 FROM spec_milestones sm WHERE sm.spec_id = s.spec_id)
     OR NOT EXISTS (SELECT 1 FROM spec_behaviors sb WHERE sb.spec_id = s.spec_id);
  IF unlinked_specs > 0 THEN
    RAISE EXCEPTION 'P2A-0018 seed left % spec rows without a milestone or behavior link', unlinked_specs;
  END IF;
END
$$;
