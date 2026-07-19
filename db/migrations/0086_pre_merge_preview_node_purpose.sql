ALTER TABLE "integration_nodes" DROP CONSTRAINT "integration_nodes_purpose_check";--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD CONSTRAINT "integration_nodes_purpose_check" CHECK ("integration_nodes"."purpose" IN ('eager_base','merge_batch','stack_head','bisect_prefix','pre_merge_preview'));
