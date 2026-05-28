-- Token-type accounting + nullable best-effort cost (P2A-cost-monitors prep).
--
-- 1. Drop the fake subscription-window denominator table (it existed only to
--    feed the bogus "$20 / 50M tokens" estimate, which is deleted).
-- 2. Split the folded `cached_tokens` column into disjoint token-type buckets.
-- 3. Make `cost_usd` NULLABLE — cost-unknown is an honest, allowed state.
-- 4. Replace `pricing_mode` with `billing_mode` and `cost_source` with
--    `cost_basis`, converting existing rows in place.
DROP TABLE "subscription_window_denominators" CASCADE;--> statement-breakpoint
ALTER TABLE "cost_records" DROP CONSTRAINT "cost_records_pricing_mode_check";--> statement-breakpoint
ALTER TABLE "cost_records" DROP CONSTRAINT "cost_records_cost_source_check";--> statement-breakpoint
ALTER TABLE "cost_records" ALTER COLUMN "cost_usd" DROP NOT NULL;--> statement-breakpoint
-- New disjoint token-type buckets. cached_tokens migrates to cached_input_tokens.
ALTER TABLE "cost_records" ADD COLUMN "cached_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_records" ADD COLUMN "cache_creation_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_records" ADD COLUMN "reasoning_output_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_records" ADD COLUMN "total_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "cost_records" SET "cached_input_tokens" = "cached_tokens";--> statement-breakpoint
UPDATE "cost_records" SET "total_tokens" = "input_tokens" + "cached_tokens" + "output_tokens";--> statement-breakpoint
-- billing_mode replaces pricing_mode:
--   per_token -> per_token, subscription_window -> subscription,
--   opportunity_cost -> self_hosted.
ALTER TABLE "cost_records" ADD COLUMN "billing_mode" text;--> statement-breakpoint
UPDATE "cost_records" SET "billing_mode" = CASE "pricing_mode"
  WHEN 'per_token' THEN 'per_token'
  WHEN 'subscription_window' THEN 'subscription'
  WHEN 'opportunity_cost' THEN 'self_hosted'
  ELSE 'self_hosted'
END;--> statement-breakpoint
ALTER TABLE "cost_records" ALTER COLUMN "billing_mode" SET NOT NULL;--> statement-breakpoint
-- cost_basis replaces cost_source (how the dollar figure was derived):
--   provider_direct -> provider_pricing, ccusage -> ccusage,
--   codexbar (the fake estimate) -> unknown, opportunity_computed -> unknown.
ALTER TABLE "cost_records" ADD COLUMN "cost_basis" text;--> statement-breakpoint
UPDATE "cost_records" SET "cost_basis" = CASE "cost_source"
  WHEN 'provider_direct' THEN 'provider_pricing'
  WHEN 'ccusage' THEN 'ccusage'
  WHEN 'codexbar' THEN 'unknown'
  WHEN 'opportunity_computed' THEN 'unknown'
  ELSE 'unknown'
END;--> statement-breakpoint
ALTER TABLE "cost_records" ALTER COLUMN "cost_basis" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_records" DROP COLUMN "cached_tokens";--> statement-breakpoint
ALTER TABLE "cost_records" DROP COLUMN "pricing_mode";--> statement-breakpoint
ALTER TABLE "cost_records" DROP COLUMN "cost_source";--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_billing_mode_check" CHECK ("cost_records"."billing_mode" IN ('per_token','subscription','self_hosted'));--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_cost_basis_check" CHECK ("cost_records"."cost_basis" IN ('ccusage','provider_pricing','unknown'));
