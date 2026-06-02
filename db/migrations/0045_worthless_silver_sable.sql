CREATE TABLE "merge_queue" (
	"queue_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"spec_id" text NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dequeue_reason" text,
	"pr_url" text NOT NULL,
	"pr_number" text NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "merge_queue_status_check" CHECK ("merge_queue"."status" IN ('queued','merging','merged','dequeued')),
	CONSTRAINT "merge_queue_dequeue_reason_check" CHECK ("merge_queue"."dequeue_reason" IS NULL OR "merge_queue"."dequeue_reason" IN ('conflict','blocked','failed'))
);
--> statement-breakpoint
ALTER TABLE "events" DROP CONSTRAINT "events_event_type_check";--> statement-breakpoint
ALTER TABLE "notification_routes" DROP CONSTRAINT "notification_routes_event_name_check";--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merge_queue_org_id" ON "merge_queue" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "merge_queue_org_project" ON "merge_queue" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "merge_queue_org_project_status" ON "merge_queue" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_active_run_unique" ON "merge_queue" USING btree ("run_id") WHERE status IN ('queued', 'merging');--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_event_type_check" CHECK ("events"."event_type" IN ('allocator.allocated','allocator.failed','allocator.requested','auditor.completed','auditor.failed','auditor.rejected','auditor.started','auditor.verdict','benchmark.accept.failed','benchmark.accept.passed','checker.completed','checker.failed','checker.rejected','checker.started','checker.verdict','ci.failed','ci.passed','ci.started','cost.failed','cost.resolved','cost.unattributable','credential.failed','credential.loaded','credential.requested','dag.budget.paused','dag.drained','dag.spec.enqueued','dag.spec.percolated','dag.spec.percolating','dag.spec.percolation_deferred','dag.spec.percolation_replan','dag.spec.speculation_held','dag.spec.speculative','gate.failed','gate.passed','gate.started','github.branch.pushed','github.failed','github.pr.created','github.pr.merged','github.pr.ready','hello.completed','hello.ssh_completed','hello.ssh_started','hello.started','job.dead_lettered','merge.behind','merge.blocked','merge.completed','merge.conflict','merge.conflict.irreconcilable','merge.conflict.replan_routed','merge.conflict.resolved','merge.conflict.resolving','merge.dequeued','merge.failed','merge.integration_cleaned','merge.queue.advanced','merge.queued','merge.rebased','merge.retargeted','merge.speculative_held','notification.enqueued','notification.failed','notification.sent','phase1.fixture.ci_pending','phase1.fixture.completed','phase1.fixture.failed','phase1.fixture.started','planner.completed','planner.failed','planner.rerequested','planner.started','planner.subtasks.emitted','recovery.inspection_opened','recovery.replan_queued','recovery.revise_routed','recovery.rollback_queued','redaction.raw_access','review.approved','review.auto_approved','review.changes_requested','review.requested','run.completed','run.failed','run.queued','run.started','runner.allocated','runner.failed','runner.released','task.completed','task.failed','task.queued','task.started','usage.accounting.observed','usage.window.observed','usage.window.pressure','workspace.failed','workspace.git_captured','workspace.prepared','writer.completed','writer.failed','writer.started','writer.subtask.completed','writer.subtask.failed','writer.subtask.started'));--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_event_name_check" CHECK ("notification_routes"."event_name" IN ('allocator.allocated','allocator.failed','allocator.requested','auditor.completed','auditor.failed','auditor.rejected','auditor.started','auditor.verdict','benchmark.accept.failed','benchmark.accept.passed','checker.completed','checker.failed','checker.rejected','checker.started','checker.verdict','ci.failed','ci.passed','ci.started','cost.failed','cost.resolved','cost.unattributable','credential.failed','credential.loaded','credential.requested','dag.budget.paused','dag.drained','dag.spec.enqueued','dag.spec.percolated','dag.spec.percolating','dag.spec.percolation_deferred','dag.spec.percolation_replan','dag.spec.speculation_held','dag.spec.speculative','gate.failed','gate.passed','gate.started','github.branch.pushed','github.failed','github.pr.created','github.pr.merged','github.pr.ready','hello.completed','hello.ssh_completed','hello.ssh_started','hello.started','job.dead_lettered','merge.behind','merge.blocked','merge.completed','merge.conflict','merge.conflict.irreconcilable','merge.conflict.replan_routed','merge.conflict.resolved','merge.conflict.resolving','merge.dequeued','merge.failed','merge.integration_cleaned','merge.queue.advanced','merge.queued','merge.rebased','merge.retargeted','merge.speculative_held','notification.enqueued','notification.failed','notification.sent','phase1.fixture.ci_pending','phase1.fixture.completed','phase1.fixture.failed','phase1.fixture.started','planner.completed','planner.failed','planner.rerequested','planner.started','planner.subtasks.emitted','recovery.inspection_opened','recovery.replan_queued','recovery.revise_routed','recovery.rollback_queued','redaction.raw_access','review.approved','review.auto_approved','review.changes_requested','review.requested','run.completed','run.failed','run.queued','run.started','runner.allocated','runner.failed','runner.released','task.completed','task.failed','task.queued','task.started','usage.accounting.observed','usage.window.observed','usage.window.pressure','workspace.failed','workspace.git_captured','workspace.prepared','writer.completed','writer.failed','writer.started','writer.subtask.completed','writer.subtask.failed','writer.subtask.started'));--> statement-breakpoint

-- P2d native merge queue: RLS, mirroring the deny-by-default pattern of
-- migration 0030/0033. merge_queue carries its own org_id (3a-style direct
-- policy), so a row is readable/writable only under its owning org scope; an
-- off-scope read sees zero rows (RLS denies by default). Idempotent via DROP
-- POLICY IF EXISTS so re-running the full migration set never errors.
ALTER TABLE merge_queue ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON merge_queue;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON merge_queue FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));
