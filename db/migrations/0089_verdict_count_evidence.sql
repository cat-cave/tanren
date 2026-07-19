-- rv-substrate follow-up #32: a behavior_verdict's three count fields are not
-- self-authenticating scalars.  Every persisted acceptance verdict now carries
-- immutable, FK-bound attempt and assertion evidence.  The application writes
-- the parent and all children in one org-scoped transaction; the deferred child
-- trigger rejects a count that does not exactly equal those real child rows.
--
-- Existing rows remain readable only through fail-closed readers: a historical
-- row without this evidence is explicitly unverifiable, never a confident count.
CREATE TABLE "behavior_verdict_attempts" (
  "org_id" text NOT NULL,
  "verdict_id" text NOT NULL,
  "attempt_ordinal" integer NOT NULL,
  "outcome" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "behavior_verdict_attempts_pk" PRIMARY KEY("org_id", "verdict_id", "attempt_ordinal"),
  CONSTRAINT "behavior_verdict_attempts_ordinal_check" CHECK ("attempt_ordinal" >= 1),
  CONSTRAINT "behavior_verdict_attempts_outcome_check" CHECK ("outcome" IN ('passed','failed_product','failed_verification_contract','failed_visual','inconclusive_infrastructure','inconclusive_external','cancelled_superseded')),
  CONSTRAINT "behavior_verdict_attempts_verdict_fk" FOREIGN KEY ("org_id", "verdict_id") REFERENCES "behavior_verdicts"("org_id", "id")
);
--> statement-breakpoint
CREATE INDEX "behavior_verdict_attempts_org_verdict" ON "behavior_verdict_attempts" USING btree ("org_id", "verdict_id");
--> statement-breakpoint
ALTER TABLE "behavior_verdict_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "behavior_verdict_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "behavior_verdict_attempts" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE "behavior_verdict_assertions" (
  "org_id" text NOT NULL,
  "verdict_id" text NOT NULL,
  "assertion_id" text NOT NULL,
  "executed" boolean NOT NULL,
  "passed" boolean,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "behavior_verdict_assertions_pk" PRIMARY KEY("org_id", "verdict_id", "assertion_id"),
  CONSTRAINT "behavior_verdict_assertions_execution_check" CHECK (("executed" AND "passed" IS NOT NULL) OR (NOT "executed" AND "passed" IS NULL)),
  CONSTRAINT "behavior_verdict_assertions_verdict_fk" FOREIGN KEY ("org_id", "verdict_id") REFERENCES "behavior_verdicts"("org_id", "id")
);
--> statement-breakpoint
CREATE INDEX "behavior_verdict_assertions_org_verdict" ON "behavior_verdict_assertions" USING btree ("org_id", "verdict_id");
--> statement-breakpoint
ALTER TABLE "behavior_verdict_assertions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "behavior_verdict_assertions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "behavior_verdict_assertions" FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE FUNCTION "enforce_behavior_verdict_count_evidence_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (append-only): % rejected', TG_TABLE_NAME, TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "behavior_verdict_attempts_immutable"
BEFORE UPDATE OR DELETE ON "behavior_verdict_attempts"
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_verdict_count_evidence_immutable"();
--> statement-breakpoint
CREATE TRIGGER "behavior_verdict_assertions_immutable"
BEFORE UPDATE OR DELETE ON "behavior_verdict_assertions"
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_verdict_count_evidence_immutable"();
--> statement-breakpoint

CREATE FUNCTION "enforce_behavior_verdict_count_integrity"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_org text;
  target_verdict text;
  expected_required integer;
  expected_executed integer;
  expected_attempts integer;
  actual_required integer;
  actual_executed integer;
  actual_attempts integer;
BEGIN
  target_org := NEW.org_id;
  target_verdict := COALESCE(to_jsonb(NEW) ->> 'verdict_id', to_jsonb(NEW) ->> 'id');

  SELECT required_assertion_count, executed_assertion_count, attempt_count
    INTO expected_required, expected_executed, expected_attempts
    FROM behavior_verdicts
   WHERE org_id = target_org AND id = target_verdict;

  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (WHERE executed)::integer
    INTO actual_required, actual_executed
    FROM behavior_verdict_assertions
   WHERE org_id = target_org AND verdict_id = target_verdict;
  SELECT COUNT(*)::integer
    INTO actual_attempts
    FROM behavior_verdict_attempts
   WHERE org_id = target_org AND verdict_id = target_verdict;

  IF expected_required <> actual_required
     OR expected_executed <> actual_executed
     OR expected_attempts <> actual_attempts THEN
    RAISE EXCEPTION
      'behavior verdict % count integrity failed: stored required/executed/attempt=%/%/%, evidence=%/%/%',
      target_verdict,
      expected_required, expected_executed, expected_attempts,
      actual_required, actual_executed, actual_attempts;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "behavior_verdict_attempt_counts_match_evidence"
AFTER INSERT ON "behavior_verdict_attempts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_verdict_count_integrity"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "behavior_verdict_assertion_counts_match_evidence"
AFTER INSERT ON "behavior_verdict_assertions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_verdict_count_integrity"();
--> statement-breakpoint
-- A caller cannot create only the scalar parent and bypass the child triggers:
-- at transaction commit, every newly-created verdict must have complete evidence.
-- Historical rows predate this trigger and remain deliberately fail-closed in readers.
CREATE CONSTRAINT TRIGGER "behavior_verdict_parent_counts_match_evidence"
AFTER INSERT ON "behavior_verdicts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_verdict_count_integrity"();
