-- rv-substrate hardening (#1043, #1065). Closes apex-critical false-green and
-- tamper gaps in the runtime-verification verdict ledger:
--   Defect A (#1043): a passed verdict must have executed >= required assertions.
--   Defect B (#1065 F4): a passed verdict must require at least one assertion.
--   Defect C (#1065 F3): the verdict / run / assertion ledger is append-only.
-- Defect D (#1065 F2 — probe target bound to the real release_instances.url) is
-- already enforced by the bh-10 production symptom stage, so it needs no schema.

-- Defect A: full-coverage floor — a passed verdict cannot execute fewer
-- assertions than it required.
ALTER TABLE "behavior_verdicts"
  ADD CONSTRAINT "behavior_verdicts_pass_requires_full_coverage"
  CHECK ("outcome" <> 'passed' OR "executed_assertion_count" >= "required_assertion_count");
--> statement-breakpoint
-- Defect B: coverage floor — a passed verdict must require at least one
-- assertion (a passed verdict with required=0 is a no-coverage false-green).
ALTER TABLE "behavior_verdicts"
  ADD CONSTRAINT "behavior_verdicts_pass_requires_coverage_floor"
  CHECK ("outcome" <> 'passed' OR "required_assertion_count" >= 1);
--> statement-breakpoint
-- Defect C: append-only verdict ledger (mirrors the 0065 immutability pattern).
CREATE FUNCTION "enforce_behavior_verdicts_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'behavior_verdicts rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "behavior_verdicts_immutable"
BEFORE UPDATE OR DELETE ON "behavior_verdicts"
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_verdicts_immutable"();
--> statement-breakpoint
-- Defect C: append-only assertion ledger.
CREATE FUNCTION "enforce_verification_assertions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'verification_assertions rows are immutable (append-only): % rejected', TG_OP;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "verification_assertions_immutable"
BEFORE UPDATE OR DELETE ON "verification_assertions"
FOR EACH ROW EXECUTE FUNCTION "enforce_verification_assertions_immutable"();
--> statement-breakpoint
-- Defect C: append-only verification runs, EXCEPT the documented status +
-- classification lifecycle transition the baseline and production stages perform.
-- Every other column is immutable and DELETE is always rejected.
CREATE FUNCTION "enforce_behavior_verification_runs_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'behavior_verification_runs rows are immutable (append-only): DELETE rejected';
  END IF;
  IF (to_jsonb(OLD) - 'status' - 'classification') IS DISTINCT FROM (to_jsonb(NEW) - 'status' - 'classification') THEN
    RAISE EXCEPTION 'behavior_verification_runs rows are immutable except status/classification: UPDATE rejected';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "behavior_verification_runs_append_only"
BEFORE UPDATE OR DELETE ON "behavior_verification_runs"
FOR EACH ROW EXECUTE FUNCTION "enforce_behavior_verification_runs_append_only"();
