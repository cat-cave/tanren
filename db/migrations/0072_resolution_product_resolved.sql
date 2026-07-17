-- A passing locked production symptom proves the product is resolved; it must
-- never be persisted as a product failure for ResolutionAuthority to consume.
ALTER TABLE "behavior_verification_runs"
  DROP CONSTRAINT "behavior_verification_runs_resolution_classification_check";
--> statement-breakpoint
ALTER TABLE "behavior_verification_runs"
  ADD CONSTRAINT "behavior_verification_runs_resolution_classification_check"
  CHECK ("classification" IS NULL OR "classification" IN (
    'product_resolved', 'product_failure', 'infra_failure', 'stale_contract', 'inconclusive'
  ));
