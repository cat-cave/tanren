ALTER TABLE "workflow_insights" DROP CONSTRAINT "workflow_insights_kind_check";--> statement-breakpoint
ALTER TABLE "workflow_insights" ADD CONSTRAINT "workflow_insights_kind_check" CHECK ("workflow_insights"."kind" IN ('retry_hotspot','model_mismatch','pace_anomaly','stuck','review_stall'));
