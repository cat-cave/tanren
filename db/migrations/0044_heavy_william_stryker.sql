ALTER TABLE "runs" ADD COLUMN "verified_ancestor_shas" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "percolation_pending" jsonb;
