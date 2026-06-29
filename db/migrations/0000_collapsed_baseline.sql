CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"cadence" text NOT NULL,
	"target_window" text DEFAULT '' NOT NULL,
	"answerer_cli" text DEFAULT '' NOT NULL,
	"enabled" text DEFAULT 'true' NOT NULL,
	"last_run" timestamp with time zone,
	"findings" jsonb DEFAULT '{"count":0,"severity":"ok","note":""}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_jobs_kind_check" CHECK ("audit_jobs"."kind" IN ('security','deps','a11y','mutation','perf','license','stale_specs')),
	CONSTRAINT "audit_jobs_cadence_check" CHECK ("audit_jobs"."cadence" IN ('nightly','weekly','monthly')),
	CONSTRAINT "audit_jobs_enabled_check" CHECK ("audit_jobs"."enabled" IN ('true','false'))
);
--> statement-breakpoint
CREATE TABLE "behaviors" (
	"id" text PRIMARY KEY NOT NULL,
	"persona_id" text NOT NULL,
	"title" text NOT NULL,
	"given" text NOT NULL,
	"when" text NOT NULL,
	"then" text NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"triage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_spec_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_severity_check" CHECK ("candidates"."severity" IN ('info','warn','fail')),
	CONSTRAINT "candidates_status_check" CHECK ("candidates"."status" IN ('new','triaged','auto_routed','accepted','folded','dismissed','closed_duplicate'))
);
--> statement-breakpoint
CREATE TABLE "ci_test_results" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"test_id" text NOT NULL,
	"file" text,
	"suite" text,
	"head_sha" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer,
	"retries" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ci_test_results_outcome_check" CHECK ("ci_test_results"."outcome" IN ('passed','failed','error','skipped')),
	CONSTRAINT "ci_test_results_attempt_check" CHECK ("ci_test_results"."attempt" >= 1),
	CONSTRAINT "ci_test_results_retries_check" CHECK ("ci_test_results"."retries" >= 0)
);
--> statement-breakpoint
CREATE TABLE "cost_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"cli" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_output_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6),
	"notional_cost_usd" numeric(14, 6),
	"billing_mode" text NOT NULL,
	"cost_basis" text NOT NULL,
	"cost_source_raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	CONSTRAINT "cost_records_billing_mode_check" CHECK ("cost_records"."billing_mode" IN ('per_token','subscription','self_hosted','unattributed')),
	CONSTRAINT "cost_records_cost_basis_check" CHECK ("cost_records"."cost_basis" IN ('ccusage','provider_response','credits','unknown','unattributed'))
);
--> statement-breakpoint
CREATE TABLE "entity_claims" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"candidate_id" text,
	"entity_id" text NOT NULL,
	"entity_kind" text DEFAULT 'unknown' NOT NULL,
	"entity_name" text DEFAULT '' NOT NULL,
	"entity_path" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"decidability" text DEFAULT 'unchecked' NOT NULL,
	"last_validation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "entity_claims_status_check" CHECK ("entity_claims"."status" IN ('open','self_resolved','agent_resolved','dismissed')),
	CONSTRAINT "entity_claims_decidability_check" CHECK ("entity_claims"."decidability" IN ('decidable','needs_agent','unchecked'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text,
	"task_id" text,
	"spec_id" text,
	"project_id" text,
	"org_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"user_id" text,
	CONSTRAINT "events_event_type_check" CHECK ("events"."event_type" IN ('allocator.allocated','allocator.failed','allocator.requested','app_env.runtime_attached','audit.posture_strands_findings','auditor.completed','auditor.failed','auditor.findings_routed','auditor.rejected','auditor.started','auditor.verdict','benchmark.accept.failed','benchmark.accept.passed','checker.completed','checker.entity_risk','checker.failed','checker.rejected','checker.started','checker.verdict','ci.flaky.detected','ci.junit_missing','ci.test.quarantined','ci.tests.reported','convergence.assessed','convergence.stalled','convergence.started','cost.ceiling_unreachable','cost.credit_rate_unknown','cost.failed','cost.managed_metering_skipped','cost.notional_unpriced','cost.overage_unobservable','cost.provider_capture_failed','cost.reconcile_failed','cost.resolved','cost.unattributed','credential.configured','credential.failed','credential.github.configured','credential.loaded','credential.requested','credential.scoped_token_minted','dag.budget.milestone','dag.budget.paused','dag.concurrency.saturated','dag.config.corrupt','dag.drained','dag.spec.attention_resolved','dag.spec.enqueued','dag.spec.needs_attention','dag.spec.percolated','dag.spec.percolating','dag.spec.percolation_deferred','dag.spec.percolation_replan','dag.spec.speculation_held','dag.spec.speculative','demo.completed','demo.evidence.recorded','demoRun.started','demoRun.verdict','deploy.failed','deploy.skipped','deploy.triggered','deploy.verified','forge.claim.anchored','forge.claim.self_resolved','forge.claim.validated','gate.advisory_failed','gate.failed','gate.passed','gate.publish_failed','gate.quarantine_excluded','gate.started','gate.verdict','github.branch.pushed','github.failed','github.pr.created','github.pr.merged','github.pr.ready','hello.completed','hello.ssh_completed','hello.ssh_started','hello.started','integration.proof.reused','integration.provisioned','integration.rebase','issue.opened','job.dead_lettered','merge.batch.bisecting','merge.batch.checking','merge.batch.culprit','merge.batch.infra_blocked','merge.batch.passed','merge.behind','merge.blocked','merge.completed','merge.conflict','merge.conflict.entity_merged','merge.conflict.irreconcilable','merge.conflict.replan_routed','merge.conflict.resolved','merge.conflict.resolving','merge.dequeued','merge.failed','merge.post_merge_failed','merge.queue.advanced','merge.queue.infra_blocked','merge.queued','merge.rebased','merge.retargeted','merge.speculative_held','notification.enqueued','notification.failed','notification.sent','planner.completed','planner.failed','planner.rerequested','planner.started','planner.subtasks.emitted','recovery.inspection_opened','recovery.replan_queued','recovery.revise_routed','recovery.rollback_queued','redaction.raw_access','release.finalized','review.approved','review.auto_approved','review.changes_requested','review.requested','run.cancelled','run.completed','run.failed','run.queued','run.started','runner.allocated','runner.failed','runner.released','runner.swept','spec.cancelled','task.completed','task.failed','task.queued','task.started','template.creation.failed','template.creation.published','template.creation.started','template.registered','template.selection.no_match','template.status_changed','triage.completed','triage.started','usage.accounting.observed','usage.read_failed','usage.token_accounting_failed','usage.window.observed','usage.window.pressure','workspace.failed','workspace.git_captured','workspace.prepared','writer.completed','writer.failed','writer.started','writer.subtask.completed','writer.subtask.failed','writer.subtask.started'))
);
--> statement-breakpoint
CREATE TABLE "experiment_cells" (
	"cell_id" text PRIMARY KEY NOT NULL,
	"experiment_id" text NOT NULL,
	"label" text NOT NULL,
	"frozen_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trials_target" integer NOT NULL,
	CONSTRAINT "experiment_cells_trials_target_check" CHECK ("experiment_cells"."trials_target" >= 1)
);
--> statement-breakpoint
CREATE TABLE "experiment_trials" (
	"trial_id" text PRIMARY KEY NOT NULL,
	"cell_id" text NOT NULL,
	"run_id" text NOT NULL,
	"trial_index" integer NOT NULL,
	"accept_result" text,
	"scorecard" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "experiment_trials_accept_result_check" CHECK ("experiment_trials"."accept_result" IS NULL OR "experiment_trials"."accept_result" IN ('passed','failed'))
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"experiment_id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"knob" text NOT NULL,
	"hypothesis" text NOT NULL,
	"seed_task_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "forge_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"run_id" text,
	"scope" text NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "forge_threads_scope_check" CHECK ("forge_threads"."scope" IN ('org','project','run')),
	CONSTRAINT "forge_threads_scope_consistency_check" CHECK (("forge_threads"."scope" = 'org' AND "forge_threads"."project_id" IS NULL AND "forge_threads"."run_id" IS NULL)
        OR ("forge_threads"."scope" = 'project' AND "forge_threads"."project_id" IS NOT NULL AND "forge_threads"."run_id" IS NULL)
        OR ("forge_threads"."scope" = 'run' AND "forge_threads"."project_id" IS NOT NULL AND "forge_threads"."run_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "forge_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"turn_index" integer NOT NULL,
	"source" jsonb NOT NULL,
	"audience" text NOT NULL,
	"author_kind" text NOT NULL,
	"render" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "forge_turns_audience_check" CHECK ("forge_turns"."audience" IN ('project:member','project:admin','org:admin','platform:admin')),
	CONSTRAINT "forge_turns_author_kind_check" CHECK ("forge_turns"."author_kind" IN ('forge_template','forge_llm','operator'))
);
--> statement-breakpoint
CREATE TABLE "inbox_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" text DEFAULT 'true' NOT NULL,
	"auto_route" text DEFAULT 'false' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbox_sources_kind_check" CHECK ("inbox_sources"."kind" IN ('issues','errors','system','manual','scheduled_audit')),
	CONSTRAINT "inbox_sources_enabled_check" CHECK ("inbox_sources"."enabled" IN ('true','false')),
	CONSTRAINT "inbox_sources_auto_route_check" CHECK ("inbox_sources"."auto_route" IN ('true','false'))
);
--> statement-breakpoint
CREATE TABLE "integration_nodes" (
	"node_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"base_branch" text NOT NULL,
	"base_sha" text NOT NULL,
	"ref" text NOT NULL,
	"purpose" text NOT NULL,
	"members" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"member_key" text NOT NULL,
	"gate_config_hash" text DEFAULT '' NOT NULL,
	"policy_version" text DEFAULT '' NOT NULL,
	"affected_fingerprint" text DEFAULT '' NOT NULL,
	"head_sha" text,
	"tree_hash" text,
	"status" text DEFAULT 'building' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_nodes_purpose_check" CHECK ("integration_nodes"."purpose" IN ('eager_base','merge_batch','stack_head','bisect_prefix')),
	CONSTRAINT "integration_nodes_status_check" CHECK ("integration_nodes"."status" IN ('building','ready','landed','stale'))
);
--> statement-breakpoint
CREATE TABLE "integration_proofs" (
	"proof_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"node_id" text NOT NULL,
	"proof_reuse_key" text NOT NULL,
	"verdict" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text,
	"task_id" text,
	"org_id" text,
	"task_kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"leased_until" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"failure_kind" text,
	"failure_message" text,
	"tenant_id" text,
	"user_id" text,
	CONSTRAINT "job_queue_status_check" CHECK ("job_queue"."status" IN ('queued','claimed','running','done','failed','cancelled','dead_letter')),
	CONSTRAINT "job_queue_task_kind_check" CHECK ("job_queue"."task_kind" IN ('hello','phase1_fixture','phase2_easy','phase2_medium','ci_poll','recovery_revise','recovery_replan','recovery_rollback','gate','review','merge','plan','write','check','audit','ci','demo','forge'))
);
--> statement-breakpoint
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
	"no_checks_since" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "merge_queue_status_check" CHECK ("merge_queue"."status" IN ('queued','merging','merged','dequeued')),
	CONSTRAINT "merge_queue_dequeue_reason_check" CHECK ("merge_queue"."dequeue_reason" IS NULL OR "merge_queue"."dequeue_reason" IN ('conflict','blocked','failed','superseded','needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "merge_queue_holds" (
	"scope_id" text NOT NULL,
	"kind" text NOT NULL,
	"org_id" text NOT NULL,
	"attempts" text DEFAULT '0' NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merge_queue_holds_kind_check" CHECK ("merge_queue_holds"."kind" IN ('recoverable_drive','batch_infra'))
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"label" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"order_index" integer NOT NULL,
	"eta" timestamp with time zone,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_status_check" CHECK ("milestones"."status" IN ('planned','in_flight','done','abandoned'))
);
--> statement-breakpoint
CREATE TABLE "notification_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"target_id" text NOT NULL,
	"event_name" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"min_severity" text DEFAULT 'info' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_routes_min_severity_check" CHECK ("notification_routes"."min_severity" IN ('ok','info','warn','fail')),
	CONSTRAINT "notification_routes_event_name_check" CHECK ("notification_routes"."event_name" IN ('allocator.allocated','allocator.failed','allocator.requested','app_env.runtime_attached','audit.posture_strands_findings','auditor.completed','auditor.failed','auditor.findings_routed','auditor.rejected','auditor.started','auditor.verdict','benchmark.accept.failed','benchmark.accept.passed','checker.completed','checker.entity_risk','checker.failed','checker.rejected','checker.started','checker.verdict','ci.flaky.detected','ci.junit_missing','ci.test.quarantined','ci.tests.reported','convergence.assessed','convergence.stalled','convergence.started','cost.ceiling_unreachable','cost.credit_rate_unknown','cost.failed','cost.managed_metering_skipped','cost.notional_unpriced','cost.overage_unobservable','cost.provider_capture_failed','cost.reconcile_failed','cost.resolved','cost.unattributed','credential.configured','credential.failed','credential.github.configured','credential.loaded','credential.requested','credential.scoped_token_minted','dag.budget.milestone','dag.budget.paused','dag.concurrency.saturated','dag.config.corrupt','dag.drained','dag.spec.attention_resolved','dag.spec.enqueued','dag.spec.needs_attention','dag.spec.percolated','dag.spec.percolating','dag.spec.percolation_deferred','dag.spec.percolation_replan','dag.spec.speculation_held','dag.spec.speculative','demo.completed','demo.evidence.recorded','demoRun.started','demoRun.verdict','deploy.failed','deploy.skipped','deploy.triggered','deploy.verified','forge.claim.anchored','forge.claim.self_resolved','forge.claim.validated','gate.advisory_failed','gate.failed','gate.passed','gate.publish_failed','gate.quarantine_excluded','gate.started','gate.verdict','github.branch.pushed','github.failed','github.pr.created','github.pr.merged','github.pr.ready','hello.completed','hello.ssh_completed','hello.ssh_started','hello.started','integration.proof.reused','integration.provisioned','integration.rebase','issue.opened','job.dead_lettered','merge.batch.bisecting','merge.batch.checking','merge.batch.culprit','merge.batch.infra_blocked','merge.batch.passed','merge.behind','merge.blocked','merge.completed','merge.conflict','merge.conflict.entity_merged','merge.conflict.irreconcilable','merge.conflict.replan_routed','merge.conflict.resolved','merge.conflict.resolving','merge.dequeued','merge.failed','merge.post_merge_failed','merge.queue.advanced','merge.queue.infra_blocked','merge.queued','merge.rebased','merge.retargeted','merge.speculative_held','notification.enqueued','notification.failed','notification.sent','planner.completed','planner.failed','planner.rerequested','planner.started','planner.subtasks.emitted','recovery.inspection_opened','recovery.replan_queued','recovery.revise_routed','recovery.rollback_queued','redaction.raw_access','release.finalized','review.approved','review.auto_approved','review.changes_requested','review.requested','run.cancelled','run.completed','run.failed','run.queued','run.started','runner.allocated','runner.failed','runner.released','runner.swept','spec.cancelled','task.completed','task.failed','task.queued','task.started','template.creation.failed','template.creation.published','template.creation.started','template.registered','template.selection.no_match','template.status_changed','triage.completed','triage.started','usage.accounting.observed','usage.read_failed','usage.token_accounting_failed','usage.window.observed','usage.window.pressure','workspace.failed','workspace.git_captured','workspace.prepared','writer.completed','writer.failed','writer.started','writer.subtask.completed','writer.subtask.failed','writer.subtask.started')),
	CONSTRAINT "notification_routes_enabled_check" CHECK ("notification_routes"."enabled" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE "notification_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"scope" text NOT NULL,
	"user_id" text,
	"channel_kind" text NOT NULL,
	"destination" text NOT NULL,
	"base_url" text,
	"label" text NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"weekend_mute" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_targets_channel_kind_check" CHECK ("notification_targets"."channel_kind" IN ('ntfy','slack','github_checks','teams','discord','email','twilio','pagerduty','webhook')),
	CONSTRAINT "notification_targets_scope_check" CHECK ("notification_targets"."scope" IN ('org','user')),
	CONSTRAINT "notification_targets_scope_user_check" CHECK (("notification_targets"."scope" = 'org' AND "notification_targets"."user_id" IS NULL) OR ("notification_targets"."scope" = 'user' AND "notification_targets"."user_id" IS NOT NULL)),
	CONSTRAINT "notification_targets_enabled_check" CHECK ("notification_targets"."enabled" IN (0,1)),
	CONSTRAINT "notification_targets_weekend_mute_check" CHECK ("notification_targets"."weekend_mute" IN (0,1)),
	CONSTRAINT "notification_targets_base_url_check" CHECK ("notification_targets"."base_url" IS NULL OR "notification_targets"."base_url" ~ '^https?://')
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"enqueued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"tenant_id" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "org_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider_kind" text NOT NULL,
	"credential_ref" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'linked' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_integrations_status_check" CHECK ("org_integrations"."status" IN ('linked','provisioning','error'))
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id"),
	CONSTRAINT "org_members_role_check" CHECK ("org_members"."role" IN ('admin','member'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"login" text NOT NULL,
	"display_name" text NOT NULL,
	"config" jsonb DEFAULT '{"version":1}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_kind_check" CHECK ("organizations"."kind" IN ('github_org','github_user','oidc'))
);
--> statement-breakpoint
CREATE TABLE "personas" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"org_id" text NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personas_scope_check" CHECK ("personas"."scope" IN ('org','project')),
	CONSTRAINT "personas_scope_project_check" CHECK (("personas"."scope" = 'org' AND "personas"."project_id" IS NULL) OR ("personas"."scope" = 'project' AND "personas"."project_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "post_merge_issue_claims" (
	"run_id" text PRIMARY KEY NOT NULL,
	"spec_id" text NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"issue_url" text,
	"issue_number" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"filed_at" timestamp with time zone,
	CONSTRAINT "post_merge_issue_claims_status_check" CHECK ("post_merge_issue_claims"."status" IN ('claimed','filed'))
);
--> statement-breakpoint
CREATE TABLE "project_app_env" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"value_ref" text,
	"plain_value" text,
	"scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"source" text DEFAULT 'byo' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_app_env_source_check" CHECK ("project_app_env"."source" IN ('byo','provisioned')),
	CONSTRAINT "project_app_env_value_xor_check" CHECK (("project_app_env"."value_ref" IS NOT NULL AND "project_app_env"."plain_value" IS NULL) OR ("project_app_env"."value_ref" IS NULL AND "project_app_env"."plain_value" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "project_members_role_check" CHECK ("project_members"."role" IN ('admin','member'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"repo_url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"runner_image" text DEFAULT 'ghcr.io/cat-cave/tanren-runner:v0' NOT NULL,
	"allocator" text DEFAULT 'local-docker' NOT NULL,
	"config" jsonb DEFAULT '{"version":1}'::jsonb NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"org_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quarantined_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"check_name" text NOT NULL,
	"test_id" text,
	"toggled_sha_count" integer NOT NULL,
	"observation_count" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" text,
	CONSTRAINT "quarantined_tests_toggled_check" CHECK ("quarantined_tests"."toggled_sha_count" >= 1),
	CONSTRAINT "quarantined_tests_observation_check" CHECK ("quarantined_tests"."observation_count" >= 1)
);
--> statement-breakpoint
CREATE TABLE "rate_limit_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"task_id" text,
	"call_site" text NOT NULL,
	"provider" text NOT NULL,
	"observation" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retry_after_s" integer,
	"tenant_id" text,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"runner_id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"project_id" text,
	"org_id" text NOT NULL,
	"allocator" text NOT NULL,
	"status" text NOT NULL,
	"ssh_host" text NOT NULL,
	"ssh_port" integer NOT NULL,
	"host_key_fingerprint" text NOT NULL,
	"image_sha" text NOT NULL,
	"container_id" text,
	"hcloud_server_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"spec_id" text NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"trigger" text NOT NULL,
	"branch" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"pr_url" text,
	"user_id" text,
	"verified_ancestor_shas" jsonb,
	"percolation_pending" jsonb,
	"auth_ref" text,
	"ancestor_stack" jsonb,
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" IN ('queued','running','halted','completed','failed','cancelled')),
	CONSTRAINT "runs_outcome_check" CHECK ("runs"."outcome" IS NULL OR "runs"."outcome" IN ('ok','halted','escape_hatch_hit','retry_budget_exhausted','convergence_stalled','window_exhausted','cancelled','failed'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"csrf_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "spec_behaviors" (
	"spec_id" text NOT NULL,
	"behavior_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_behaviors_spec_id_behavior_id_pk" PRIMARY KEY("spec_id","behavior_id")
);
--> statement-breakpoint
CREATE TABLE "spec_dependencies" (
	"from_spec_id" text NOT NULL,
	"to_spec_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_dependencies_from_spec_id_to_spec_id_pk" PRIMARY KEY("from_spec_id","to_spec_id"),
	CONSTRAINT "spec_dependencies_no_self_loop" CHECK ("spec_dependencies"."from_spec_id" <> "spec_dependencies"."to_spec_id")
);
--> statement-breakpoint
CREATE TABLE "spec_milestones" (
	"spec_id" text NOT NULL,
	"milestone_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_milestones_spec_id_milestone_id_pk" PRIMARY KEY("spec_id","milestone_id")
);
--> statement-breakpoint
CREATE TABLE "specs" (
	"spec_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"org_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'tbd' NOT NULL,
	"mode" text DEFAULT 'from_scratch' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "specs_status_check" CHECK ("specs"."status" IN ('open','in_flight','review','merged','halted','cancelled','needs_attention')),
	CONSTRAINT "specs_priority_check" CHECK ("specs"."priority" IN ('P0','P1','P2','tbd')),
	CONSTRAINT "specs_mode_check" CHECK ("specs"."mode" IN ('specialize_seed','from_scratch'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"task_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"parent_task_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"outcome" text,
	"failure_kind" text,
	"agent_kind" text NOT NULL,
	"cli" text NOT NULL,
	"model" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"user_id" text,
	CONSTRAINT "tasks_kind_check" CHECK ("tasks"."kind" IN ('plan','write','check','audit','ci','review','merge','demo','forge','triage','convergence')),
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" IN ('queued','claimed','running','done','failed','cancelled')),
	CONSTRAINT "tasks_agent_kind_check" CHECK ("tasks"."agent_kind" IN ('system','operator','writer','answerer','forge_template','ci_poller')),
	CONSTRAINT "tasks_outcome_check" CHECK ("tasks"."outcome" IS NULL OR "tasks"."outcome" IN ('passed','ok','pending','failed','rejected_by_checker','rejected_by_auditor','timed_out','crashed','window_exhausted','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"repo_ref" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"channel" text DEFAULT 'lts' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "templates_status_check" CHECK ("templates"."status" IN ('draft','validated','degraded','official')),
	CONSTRAINT "templates_channel_check" CHECK ("templates"."channel" IN ('lts','nightly'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"provider_subject" text NOT NULL,
	"login" text,
	"email" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_provider_check" CHECK ("users"."provider" IN ('github_oauth','oidc','local_dev'))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"org_id" text NOT NULL,
	"event_type" text NOT NULL,
	"delivery_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_events_status_check" CHECK ("webhook_events"."status" IN ('received','processed','failed','dead_lettered'))
);
--> statement-breakpoint
CREATE TABLE "workflow_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"project_id" text NOT NULL,
	"severity" text NOT NULL,
	"payload" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	CONSTRAINT "workflow_insights_kind_check" CHECK ("workflow_insights"."kind" IN ('retry_hotspot','model_mismatch','pace_anomaly','stuck','review_stall','ci_flaky')),
	CONSTRAINT "workflow_insights_severity_check" CHECK ("workflow_insights"."severity" IN ('info','warn','fail'))
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_jobs" ADD CONSTRAINT "audit_jobs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_jobs" ADD CONSTRAINT "audit_jobs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behaviors" ADD CONSTRAINT "behaviors_persona_id_personas_id_fk" FOREIGN KEY ("persona_id") REFERENCES "public"."personas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_source_id_inbox_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inbox_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_resolved_spec_id_specs_spec_id_fk" FOREIGN KEY ("resolved_spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD CONSTRAINT "ci_test_results_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD CONSTRAINT "ci_test_results_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ci_test_results" ADD CONSTRAINT "ci_test_results_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_records" ADD CONSTRAINT "cost_records_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_claims" ADD CONSTRAINT "entity_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_claims" ADD CONSTRAINT "entity_claims_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_claims" ADD CONSTRAINT "entity_claims_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_cells" ADD CONSTRAINT "experiment_cells_experiment_id_experiments_experiment_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("experiment_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_trials" ADD CONSTRAINT "experiment_trials_cell_id_experiment_cells_cell_id_fk" FOREIGN KEY ("cell_id") REFERENCES "public"."experiment_cells"("cell_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_trials" ADD CONSTRAINT "experiment_trials_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_action_proposals" ADD CONSTRAINT "forge_action_proposals_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_action_proposals" ADD CONSTRAINT "forge_action_proposals_thread_id_forge_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."forge_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_action_proposals" ADD CONSTRAINT "forge_action_proposals_proposing_turn_id_forge_turns_id_fk" FOREIGN KEY ("proposing_turn_id") REFERENCES "public"."forge_turns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_threads" ADD CONSTRAINT "forge_threads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_threads" ADD CONSTRAINT "forge_threads_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forge_turns" ADD CONSTRAINT "forge_turns_thread_id_forge_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."forge_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_sources" ADD CONSTRAINT "inbox_sources_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_sources" ADD CONSTRAINT "inbox_sources_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD CONSTRAINT "integration_nodes_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_nodes" ADD CONSTRAINT "integration_nodes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_proofs" ADD CONSTRAINT "integration_proofs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_proofs" ADD CONSTRAINT "integration_proofs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_proofs" ADD CONSTRAINT "integration_proofs_node_id_integration_nodes_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."integration_nodes"("node_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_queue" ADD CONSTRAINT "job_queue_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue" ADD CONSTRAINT "merge_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_queue_holds" ADD CONSTRAINT "merge_queue_holds_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_routes" ADD CONSTRAINT "notification_routes_target_id_notification_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."notification_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_integrations" ADD CONSTRAINT "org_integrations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personas" ADD CONSTRAINT "personas_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_merge_issue_claims" ADD CONSTRAINT "post_merge_issue_claims_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_merge_issue_claims" ADD CONSTRAINT "post_merge_issue_claims_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_merge_issue_claims" ADD CONSTRAINT "post_merge_issue_claims_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_merge_issue_claims" ADD CONSTRAINT "post_merge_issue_claims_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_app_env" ADD CONSTRAINT "project_app_env_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantined_tests" ADD CONSTRAINT "quarantined_tests_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quarantined_tests" ADD CONSTRAINT "quarantined_tests_cleared_by_users_id_fk" FOREIGN KEY ("cleared_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_observations" ADD CONSTRAINT "rate_limit_observations_task_id_tasks_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_behaviors" ADD CONSTRAINT "spec_behaviors_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_behaviors" ADD CONSTRAINT "spec_behaviors_behavior_id_behaviors_id_fk" FOREIGN KEY ("behavior_id") REFERENCES "public"."behaviors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_dependencies" ADD CONSTRAINT "spec_dependencies_from_spec_id_specs_spec_id_fk" FOREIGN KEY ("from_spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_dependencies" ADD CONSTRAINT "spec_dependencies_to_spec_id_specs_spec_id_fk" FOREIGN KEY ("to_spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_milestones" ADD CONSTRAINT "spec_milestones_spec_id_specs_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."specs"("spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_milestones" ADD CONSTRAINT "spec_milestones_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "specs" ADD CONSTRAINT "specs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_tasks_task_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_source_id_inbox_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."inbox_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_insights" ADD CONSTRAINT "workflow_insights_project_id_projects_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_insights" ADD CONSTRAINT "workflow_insights_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_tokens_user_id" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_unique" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "audit_jobs_org_id" ON "audit_jobs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "audit_jobs_project_id" ON "audit_jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "behaviors_persona_id" ON "behaviors" USING btree ("persona_id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_source_external_unique" ON "candidates" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "candidates_org_id" ON "candidates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "candidates_project_id" ON "candidates" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "candidates_status" ON "candidates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "ci_test_results_org_id" ON "ci_test_results" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "ci_test_results_org_project" ON "ci_test_results" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "ci_test_results_project_test" ON "ci_test_results" USING btree ("project_id","test_id","observed_at" desc);--> statement-breakpoint
CREATE INDEX "ci_test_results_run" ON "ci_test_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "cost_records_org_id" ON "cost_records" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "cost_records_org_run" ON "cost_records" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_claims_project_entity_candidate_unique" ON "entity_claims" USING btree ("project_id","entity_id","candidate_id");--> statement-breakpoint
CREATE INDEX "entity_claims_org_id" ON "entity_claims" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "entity_claims_org_project" ON "entity_claims" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "entity_claims_project_status" ON "entity_claims" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "entity_claims_candidate_id" ON "entity_claims" USING btree ("candidate_id");--> statement-breakpoint
CREATE INDEX "events_run_id_ts" ON "events" USING btree ("run_id","ts");--> statement-breakpoint
CREATE INDEX "events_event_type" ON "events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "events_org_id" ON "events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "events_org_run_ts" ON "events" USING btree ("org_id","run_id","ts");--> statement-breakpoint
CREATE INDEX "events_org_project_ts" ON "events" USING btree ("org_id","project_id","ts");--> statement-breakpoint
CREATE INDEX "experiment_cells_experiment_id" ON "experiment_cells" USING btree ("experiment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_trials_run_unique" ON "experiment_trials" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_trials_cell_index_unique" ON "experiment_trials" USING btree ("cell_id","trial_index");--> statement-breakpoint
CREATE INDEX "experiment_trials_cell_id" ON "experiment_trials" USING btree ("cell_id");--> statement-breakpoint
CREATE INDEX "experiments_org_id" ON "experiments" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "forge_action_proposals_org_id" ON "forge_action_proposals" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "forge_action_proposals_thread_id" ON "forge_action_proposals" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "forge_action_proposals_status" ON "forge_action_proposals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "forge_threads_org_id" ON "forge_threads" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "forge_threads_project_id" ON "forge_threads" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "forge_threads_run_id" ON "forge_threads" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_turns_thread_index_unique" ON "forge_turns" USING btree ("thread_id","turn_index");--> statement-breakpoint
CREATE INDEX "forge_turns_thread_id" ON "forge_turns" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "inbox_sources_org_id" ON "inbox_sources" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "inbox_sources_project_id" ON "inbox_sources" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_sources_provisioned_unique" ON "inbox_sources" USING btree ("org_id","project_id","kind") WHERE ("inbox_sources"."config"->>'managedBy') = 'integration-provisioner';--> statement-breakpoint
CREATE INDEX "integration_nodes_org_id" ON "integration_nodes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_nodes_org_project" ON "integration_nodes" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_nodes_org_member_key_unique" ON "integration_nodes" USING btree ("org_id","member_key");--> statement-breakpoint
CREATE INDEX "integration_proofs_org_id" ON "integration_proofs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_proofs_org_project" ON "integration_proofs" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "integration_proofs_node_id" ON "integration_proofs" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_proofs_org_reuse_key_unique" ON "integration_proofs" USING btree ("org_id","proof_reuse_key");--> statement-breakpoint
CREATE INDEX "job_queue_queued" ON "job_queue" USING btree ("task_kind","enqueued_at") WHERE "job_queue"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "job_queue_lease" ON "job_queue" USING btree ("leased_until") WHERE "job_queue"."status" = 'running';--> statement-breakpoint
CREATE INDEX "merge_queue_org_id" ON "merge_queue" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "merge_queue_org_project" ON "merge_queue" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "merge_queue_org_project_status" ON "merge_queue" USING btree ("org_id","project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_active_run_unique" ON "merge_queue" USING btree ("run_id") WHERE status IN ('queued', 'merging');--> statement-breakpoint
CREATE UNIQUE INDEX "merge_queue_holds_identity" ON "merge_queue_holds" USING btree ("org_id","scope_id","kind");--> statement-breakpoint
CREATE INDEX "merge_queue_holds_org_id" ON "merge_queue_holds" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_project_label_unique" ON "milestones" USING btree ("project_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "milestones_project_order_unique" ON "milestones" USING btree ("project_id","order_index");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_routes_target_event_unique" ON "notification_routes" USING btree ("target_id","event_name");--> statement-breakpoint
CREATE INDEX "notification_routes_event_name" ON "notification_routes" USING btree ("event_name");--> statement-breakpoint
CREATE INDEX "notification_targets_org_id" ON "notification_targets" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "notification_targets_user_id" ON "notification_targets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notification_targets_channel_kind" ON "notification_targets" USING btree ("channel_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_targets_provisioned_unique" ON "notification_targets" USING btree ("org_id","channel_kind","destination") WHERE "notification_targets"."scope" = 'org' AND "notification_targets"."user_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "org_integrations_org_provider_unique" ON "org_integrations" USING btree ("org_id","provider_kind");--> statement-breakpoint
CREATE INDEX "org_integrations_org_id" ON "org_integrations" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_provider_unique" ON "organizations" USING btree ("kind","external_id");--> statement-breakpoint
CREATE INDEX "personas_org_id" ON "personas" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "personas_project_id" ON "personas" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "post_merge_issue_claims_org_id" ON "post_merge_issue_claims" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "post_merge_issue_claims_org_project" ON "post_merge_issue_claims" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_app_env_project_key_unique" ON "project_app_env" USING btree ("project_id","key");--> statement-breakpoint
CREATE INDEX "project_app_env_project_id" ON "project_app_env" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "projects_org_id" ON "projects" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quarantined_tests_active_unique" ON "quarantined_tests" USING btree ("project_id",coalesce("test_id", "check_name")) WHERE "quarantined_tests"."cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX "quarantined_tests_project" ON "quarantined_tests" USING btree ("project_id","quarantined_at" desc);--> statement-breakpoint
CREATE INDEX "runners_org_id" ON "runners" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "runs_org_id" ON "runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "runs_org_run" ON "runs" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "runs_org_project" ON "runs" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE INDEX "runs_org_auth_ref" ON "runs" USING btree ("org_id","auth_ref");--> statement-breakpoint
CREATE INDEX "sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "spec_behaviors_behavior_id" ON "spec_behaviors" USING btree ("behavior_id");--> statement-breakpoint
CREATE INDEX "spec_dependencies_to_spec_id" ON "spec_dependencies" USING btree ("to_spec_id");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_milestones_spec_unique" ON "spec_milestones" USING btree ("spec_id");--> statement-breakpoint
CREATE INDEX "spec_milestones_milestone_id" ON "spec_milestones" USING btree ("milestone_id");--> statement-breakpoint
CREATE INDEX "specs_org_id" ON "specs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "tasks_org_id" ON "tasks" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "tasks_org_run" ON "tasks" USING btree ("org_id","run_id");--> statement-breakpoint
CREATE INDEX "templates_org_id" ON "templates" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "templates_status" ON "templates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "templates_channel" ON "templates" USING btree ("channel");--> statement-breakpoint
CREATE UNIQUE INDEX "users_provider_subject_unique" ON "users" USING btree ("provider","provider_subject");--> statement-breakpoint
CREATE INDEX "webhook_events_org_id" ON "webhook_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "webhook_events_source_id" ON "webhook_events" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "webhook_events_status" ON "webhook_events" USING btree ("status");--> statement-breakpoint
CREATE INDEX "workflow_insights_project_kind" ON "workflow_insights" USING btree ("project_id","kind","computed_at" desc);
-- ===========================================================================
-- RLS + roles + plane-split de-privilege (hand-written tail).
--
-- Drizzle does not model roles, Row-Level Security, or grants, so this block
-- lives as hand-written SQL appended after the generated DDL above: it creates
-- the three runtime roles, applies the data-plane de-privilege REVOKEs, and
-- enables RLS with a deny-by-default org-isolation policy on every tenant
-- table. Migrations run as the OWNER (`tanren`); only the runtime query paths
-- connect as the restricted roles the policies govern.
--
-- Idempotent: every role create guards on pg_roles, every policy DROPs IF
-- EXISTS, so re-running the migration on an existing DB never errors.
-- ===========================================================================

-- --- Role: tanren_app (restricted control-plane runtime, NOBYPASSRLS) --------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tanren_app') THEN
    CREATE ROLE tanren_app LOGIN PASSWORD 'tanren_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tanren_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tanren_app;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tanren_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tanren_app;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tanren_app;--> statement-breakpoint

-- --- Role: tanren_system (narrow BYPASSRLS for cross-org system reads) -------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tanren_system') THEN
    CREATE ROLE tanren_system LOGIN PASSWORD 'tanren_system'
      NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tanren_system;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tanren_system;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tanren_system;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tanren_system;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tanren_system;--> statement-breakpoint

-- --- Role: tanren_dataplane (de-privileged worker runtime, NOBYPASSRLS) ------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tanren_dataplane') THEN
    CREATE ROLE tanren_dataplane LOGIN PASSWORD 'tanren_dataplane'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tanren_dataplane;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tanren_dataplane;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tanren_dataplane;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tanren_dataplane;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE tanren IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO tanren_dataplane;--> statement-breakpoint

-- --- Data-plane de-privilege (plane-split P3b/P3c): the worker routes these
--     writes through the control plane, so the data-plane role loses them.
--     events: keep SELECT for org-scoped autonomy signal reads; drop writes.
--     cost_records: keep SELECT (usage accrual), drop writes.
--     runs/specs/tasks: keep SELECT (drive + contextualize), drop writes.
REVOKE INSERT, UPDATE, DELETE ON TABLE events FROM tanren_dataplane;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE cost_records FROM tanren_dataplane;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE runs FROM tanren_dataplane;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE specs FROM tanren_dataplane;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE tasks FROM tanren_dataplane;--> statement-breakpoint

-- ===========================================================================
-- Row-Level Security: deny-by-default org isolation on every tenant table.
--
-- A policy comparing `org_id = current_setting('app.current_org_id', true)`
-- (missing_ok) is never true when the GUC is unset, so an unscoped query sees
-- ZERO rows and a WITH CHECK write is rejected (42501). `runWithOrgScope` sets
-- the GUC via SET LOCAL, so a correctly-scoped query behaves exactly as before.
-- Tables without their own org_id are scoped through their parent via EXISTS.
-- Cross-org system tables (job_queue, users, sessions, api_tokens,
-- notifications, rate_limit_observations) stay OUTSIDE RLS. Idempotent via
-- DROP POLICY IF EXISTS.
-- ===========================================================================

-- 3a. Direct-org_id tenant tables (own org_id column = the tenant key).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects', 'specs', 'runs', 'tasks', 'events', 'cost_records', 'runners',
    'personas', 'org_members', 'forge_threads', 'forge_action_proposals',
    'inbox_sources', 'candidates', 'notification_targets', 'audit_jobs',
    'merge_queue', 'post_merge_issue_claims', 'org_integrations', 'experiments',
    'ci_test_results', 'integration_nodes', 'integration_proofs',
    'merge_queue_holds', 'webhook_events', 'entity_claims'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS rls_org_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY rls_org_isolation ON %I FOR ALL
         USING (org_id = current_setting(''app.current_org_id'', true))
         WITH CHECK (org_id = current_setting(''app.current_org_id'', true))',
      t
    );
  END LOOP;
END
$$;--> statement-breakpoint

-- 3b. organizations: the tenant root keys on `id` (not `org_id`).
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON organizations;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON organizations FOR ALL
  USING (id = current_setting('app.current_org_id', true))
  WITH CHECK (id = current_setting('app.current_org_id', true));--> statement-breakpoint

-- 3c. templates: direct org_id, WITH a cross-org-READABLE `official` tier so any
--     org can SEED from a blessed template. The WITH CHECK keeps the write side
--     org-owned (no official escape hatch) — an official template is authored
--     only under the platform org that owns the row.
ALTER TABLE templates ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON templates;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON templates FOR ALL
  USING (org_id = current_setting('app.current_org_id', true) OR status = 'official')
  WITH CHECK (org_id = current_setting('app.current_org_id', true));--> statement-breakpoint

-- 3d. FK-scoped tenant tables (no own org_id; scoped via the parent's org_id).
ALTER TABLE behaviors ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behaviors;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behaviors FOR ALL
  USING (EXISTS (SELECT 1 FROM personas p WHERE p.id = behaviors.persona_id))
  WITH CHECK (EXISTS (SELECT 1 FROM personas p WHERE p.id = behaviors.persona_id));--> statement-breakpoint

ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON milestones;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON milestones FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = milestones.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = milestones.project_id));--> statement-breakpoint

ALTER TABLE spec_behaviors ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON spec_behaviors;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON spec_behaviors FOR ALL
  USING (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_behaviors.spec_id))
  WITH CHECK (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_behaviors.spec_id));--> statement-breakpoint

ALTER TABLE spec_milestones ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON spec_milestones;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON spec_milestones FOR ALL
  USING (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_milestones.spec_id))
  WITH CHECK (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_milestones.spec_id));--> statement-breakpoint

ALTER TABLE spec_dependencies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON spec_dependencies;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON spec_dependencies FOR ALL
  USING (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_dependencies.from_spec_id))
  WITH CHECK (EXISTS (SELECT 1 FROM specs s WHERE s.spec_id = spec_dependencies.from_spec_id));--> statement-breakpoint

ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON project_members;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON project_members FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = project_members.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = project_members.project_id));--> statement-breakpoint

ALTER TABLE forge_turns ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON forge_turns;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON forge_turns FOR ALL
  USING (EXISTS (SELECT 1 FROM forge_threads ft WHERE ft.id = forge_turns.thread_id))
  WITH CHECK (EXISTS (SELECT 1 FROM forge_threads ft WHERE ft.id = forge_turns.thread_id));--> statement-breakpoint

ALTER TABLE workflow_insights ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON workflow_insights;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON workflow_insights FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = workflow_insights.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = workflow_insights.project_id));--> statement-breakpoint

ALTER TABLE notification_routes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON notification_routes;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON notification_routes FOR ALL
  USING (EXISTS (SELECT 1 FROM notification_targets nt WHERE nt.id = notification_routes.target_id))
  WITH CHECK (EXISTS (SELECT 1 FROM notification_targets nt WHERE nt.id = notification_routes.target_id));--> statement-breakpoint

ALTER TABLE quarantined_tests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON quarantined_tests;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON quarantined_tests FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = quarantined_tests.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = quarantined_tests.project_id));--> statement-breakpoint

ALTER TABLE project_app_env ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON project_app_env;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON project_app_env FOR ALL
  USING (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = project_app_env.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM projects p WHERE p.project_id = project_app_env.project_id));--> statement-breakpoint

ALTER TABLE experiment_cells ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON experiment_cells;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON experiment_cells FOR ALL
  USING (EXISTS (SELECT 1 FROM experiments e WHERE e.experiment_id = experiment_cells.experiment_id))
  WITH CHECK (EXISTS (SELECT 1 FROM experiments e WHERE e.experiment_id = experiment_cells.experiment_id));--> statement-breakpoint

ALTER TABLE experiment_trials ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON experiment_trials;--> statement-breakpoint
CREATE POLICY rls_org_isolation ON experiment_trials FOR ALL
  USING (EXISTS (SELECT 1 FROM experiment_cells c WHERE c.cell_id = experiment_trials.cell_id))
  WITH CHECK (EXISTS (SELECT 1 FROM experiment_cells c WHERE c.cell_id = experiment_trials.cell_id));
