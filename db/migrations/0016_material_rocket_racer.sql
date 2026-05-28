ALTER TABLE "cost_records" DROP CONSTRAINT "cost_records_cost_basis_check";--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_cost_basis_check" CHECK ("cost_records"."cost_basis" IN ('ccusage','provider_pricing','credits','unknown'));
