-- Templating doctrine collapse (docs/roadmap/templating-system.md).
--
-- The single-fragment-only scaffold path: every greenfield derive composes a
-- fragment-based template and materializes it into a fresh seed repo. The
-- dual `templates` registry + agent-template-build DAG is gone; the
-- per-fragment authoring DAG (F2) fills missing fragments on demand into the
-- per-org `fragments` table.
--
-- This migration:
--   1. DROPS the `templates` table (org template registry — replaced by the
--      composer + the org-scoped fragment store + the bundled core library).
--   2. CREATES the `fragments` table (per-fragment authoring run output).
--   3. RE-CREATES the events.event_type CHECK constraint without `template.*`
--      event types (the template-creation/maintenance/build vocabulary) and
--      WITH the new `fragment.authoring.{started,succeeded,failed}` events.
--   4. RE-CREATES notification_routes.event_name CHECK with the same vocabulary.

-- 1. DROP templates ---------------------------------------------------------
DROP TABLE IF EXISTS "templates" CASCADE;--> statement-breakpoint

-- 2. CREATE fragments -------------------------------------------------------
CREATE TABLE "fragments" (
	"fragment_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"version" text NOT NULL,
	"body_ts" text NOT NULL,
	"contract" jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"validated_at" timestamp with time zone,
	CONSTRAINT "fragments_status_check" CHECK ("fragments"."status" IN ('draft','validated'))
);--> statement-breakpoint

ALTER TABLE "fragments" ADD CONSTRAINT "fragments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "fragments_org_kind_label_version" ON "fragments" USING btree ("org_id","kind","label","version");--> statement-breakpoint
CREATE INDEX "fragments_org_id" ON "fragments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "fragments_status" ON "fragments" USING btree ("status");--> statement-breakpoint

-- 3. RLS on fragments (strictly org-scoped; no cross-org tier — the bundled
-- core IS the cross-org defaults, and org-authored fragments are always private).
ALTER TABLE fragments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON fragments;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON fragments FOR ALL
  USING (org_id = current_setting('app.current_org_id', true))
  WITH CHECK (org_id = current_setting('app.current_org_id', true));--> statement-breakpoint

-- 4. Update event_type vocabulary ------------------------------------------
ALTER TABLE "events" DROP CONSTRAINT "events_event_type_check";--> statement-breakpoint
ALTER TABLE "notification_routes" DROP CONSTRAINT "notification_routes_event_name_check";--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_event_type_check" CHECK ("events"."event_type" IN ('allocator.allocated','allocator.failed','allocator.requested','app_env.runtime_attached','audit.posture_strands_findings','auditor.completed','auditor.failed','auditor.findings_routed','auditor.rejected','auditor.started','auditor.verdict','benchmark.accept.failed','benchmark.accept.passed','checker.completed','checker.entity_risk','checker.failed','checker.rejected','checker.started','checker.verdict','ci.flaky.detected','ci.junit_missing','ci.test.quarantined','ci.tests.reported','convergence.assessed','convergence.stalled','convergence.started','cost.ceiling_unreachable','cost.credit_rate_unknown','cost.failed','cost.managed_metering_skipped','cost.notional_unpriced','cost.overage_unobservable','cost.provider_capture_failed','cost.reconcile_failed','cost.resolved','cost.unattributed','credential.configured','credential.failed','credential.github.configured','credential.loaded','credential.requested','credential.scoped_token_minted','dag.budget.milestone','dag.budget.paused','dag.concurrency.saturated','dag.config.corrupt','dag.drained','dag.spec.ancestor_not_ready','dag.spec.attention_resolved','dag.spec.enqueued','dag.spec.needs_attention','dag.spec.percolated','dag.spec.percolating','dag.spec.percolation_deferred','dag.spec.percolation_replan','dag.spec.redriven','dag.spec.speculation_held','dag.spec.speculative','demo.completed','demo.evidence.recorded','demoRun.started','demoRun.verdict','deploy.failed','deploy.skipped','deploy.triggered','deploy.verified','designOracle.started','designOracle.verdict','forge.claim.anchored','forge.claim.self_resolved','forge.claim.validated','fragment.authoring.failed','fragment.authoring.started','fragment.authoring.succeeded','gate.advisory_failed','gate.failed','gate.passed','gate.publish_failed','gate.quarantine_excluded','gate.started','gate.verdict','github.branch.pushed','github.failed','github.pr.created','github.pr.merged','github.pr.no_commits','github.pr.ready','hello.completed','hello.ssh_completed','hello.ssh_started','hello.started','integration.proof.reused','integration.provisioned','integration.rebase','issue.opened','job.lease_expired','merge.batch.bisecting','merge.batch.checking','merge.batch.culprit','merge.batch.gate_rework_routed','merge.batch.infra_blocked','merge.batch.passed','merge.behind','merge.blocked','merge.completed','merge.conflict','merge.conflict.entity_merged','merge.conflict.irreconcilable','merge.conflict.replan_routed','merge.conflict.resolved','merge.conflict.resolving','merge.dequeued','merge.failed','merge.post_merge_failed','merge.queue.advanced','merge.queue.infra_blocked','merge.queued','merge.rebased','merge.regate.gate_rework_routed','merge.regate_pending','merge.retargeted','merge.speculative_held','notification.enqueued','notification.failed','notification.sent','planner.completed','planner.failed','planner.rerequested','planner.started','planner.subtasks.emitted','recovery.inspection_opened','recovery.replan_queued','recovery.revise_routed','recovery.rollback_queued','redaction.raw_access','release.finalized','review.approved','review.auto_approved','review.changes_requested','review.requested','run.cancelled','run.completed','run.failed','run.queued','run.started','runner.allocated','runner.failed','runner.released','runner.swept','spec.cancelled','task.completed','task.failed','task.queued','task.started','triage.completed','triage.started','usage.accounting.observed','usage.read_failed','usage.token_accounting_failed','usage.window.observed','usage.window.pressure','workspace.bootstrap_deferred','workspace.failed','workspace.git_captured','workspace.prepared','writer.completed','writer.failed','writer.started','writer.subtask.completed','writer.subtask.failed','writer.subtask.progress','writer.subtask.started'));--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_event_name_check" CHECK ("notification_routes"."event_name" IN ('allocator.allocated','allocator.failed','allocator.requested','app_env.runtime_attached','audit.posture_strands_findings','auditor.completed','auditor.failed','auditor.findings_routed','auditor.rejected','auditor.started','auditor.verdict','benchmark.accept.failed','benchmark.accept.passed','checker.completed','checker.entity_risk','checker.failed','checker.rejected','checker.started','checker.verdict','ci.flaky.detected','ci.junit_missing','ci.test.quarantined','ci.tests.reported','convergence.assessed','convergence.stalled','convergence.started','cost.ceiling_unreachable','cost.credit_rate_unknown','cost.failed','cost.managed_metering_skipped','cost.notional_unpriced','cost.overage_unobservable','cost.provider_capture_failed','cost.reconcile_failed','cost.resolved','cost.unattributed','credential.configured','credential.failed','credential.github.configured','credential.loaded','credential.requested','credential.scoped_token_minted','dag.budget.milestone','dag.budget.paused','dag.concurrency.saturated','dag.config.corrupt','dag.drained','dag.spec.ancestor_not_ready','dag.spec.attention_resolved','dag.spec.enqueued','dag.spec.needs_attention','dag.spec.percolated','dag.spec.percolating','dag.spec.percolation_deferred','dag.spec.percolation_replan','dag.spec.redriven','dag.spec.speculation_held','dag.spec.speculative','demo.completed','demo.evidence.recorded','demoRun.started','demoRun.verdict','deploy.failed','deploy.skipped','deploy.triggered','deploy.verified','designOracle.started','designOracle.verdict','forge.claim.anchored','forge.claim.self_resolved','forge.claim.validated','fragment.authoring.failed','fragment.authoring.started','fragment.authoring.succeeded','gate.advisory_failed','gate.failed','gate.passed','gate.publish_failed','gate.quarantine_excluded','gate.started','gate.verdict','github.branch.pushed','github.failed','github.pr.created','github.pr.merged','github.pr.no_commits','github.pr.ready','hello.completed','hello.ssh_completed','hello.ssh_started','hello.started','integration.proof.reused','integration.provisioned','integration.rebase','issue.opened','job.lease_expired','merge.batch.bisecting','merge.batch.checking','merge.batch.culprit','merge.batch.gate_rework_routed','merge.batch.infra_blocked','merge.batch.passed','merge.behind','merge.blocked','merge.completed','merge.conflict','merge.conflict.entity_merged','merge.conflict.irreconcilable','merge.conflict.replan_routed','merge.conflict.resolved','merge.conflict.resolving','merge.dequeued','merge.failed','merge.post_merge_failed','merge.queue.advanced','merge.queue.infra_blocked','merge.queued','merge.rebased','merge.regate.gate_rework_routed','merge.regate_pending','merge.retargeted','merge.speculative_held','notification.enqueued','notification.failed','notification.sent','planner.completed','planner.failed','planner.rerequested','planner.started','planner.subtasks.emitted','recovery.inspection_opened','recovery.replan_queued','recovery.revise_routed','recovery.rollback_queued','redaction.raw_access','release.finalized','review.approved','review.auto_approved','review.changes_requested','review.requested','run.cancelled','run.completed','run.failed','run.queued','run.started','runner.allocated','runner.failed','runner.released','runner.swept','spec.cancelled','task.completed','task.failed','task.queued','task.started','triage.completed','triage.started','usage.accounting.observed','usage.read_failed','usage.token_accounting_failed','usage.window.observed','usage.window.pressure','workspace.bootstrap_deferred','workspace.failed','workspace.git_captured','workspace.prepared','writer.completed','writer.failed','writer.started','writer.subtask.completed','writer.subtask.failed','writer.subtask.progress','writer.subtask.started'));
