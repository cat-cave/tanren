CREATE TABLE "forge_action_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"proposing_turn_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"args" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	CONSTRAINT "forge_action_proposals_tool_check" CHECK ("forge_action_proposals"."tool_name" IN ('tanren.create_spec','tanren.trigger_run','tanren.rerun_task','tanren.acknowledge_insight')),
	CONSTRAINT "forge_action_proposals_status_check" CHECK ("forge_action_proposals"."status" IN ('pending','approved','rejected','executed','failed'))
);
--> statement-breakpoint
ALTER TABLE "forge_action_proposals" ADD CONSTRAINT "forge_action_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_action_proposals" ADD CONSTRAINT "forge_action_proposals_thread_id_forge_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."forge_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_action_proposals" ADD CONSTRAINT "forge_action_proposals_proposing_turn_id_forge_turns_id_fk" FOREIGN KEY ("proposing_turn_id") REFERENCES "public"."forge_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "forge_action_proposals_org_id" ON "forge_action_proposals" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "forge_action_proposals_thread_id" ON "forge_action_proposals" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "forge_action_proposals_status" ON "forge_action_proposals" USING btree ("status");
