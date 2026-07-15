-- Zero-user clean replacement: the former app-env shape is not a compatibility
-- authority. Recreate it directly in the lifecycle model represented by this
-- migration's generated snapshot.
DROP TABLE "project_app_env" CASCADE;--> statement-breakpoint
CREATE TABLE "behavior_integration_requirements" (
	"org_id" text NOT NULL,
	"behavior_revision_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"relation_role" text DEFAULT 'requires' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "behavior_integration_requirements_org_id_behavior_revision_id_requirement_id_pk" PRIMARY KEY("org_id","behavior_revision_id","requirement_id"),
	CONSTRAINT "behavior_integration_requirements_role_check" CHECK ("behavior_integration_requirements"."relation_role" IN ('requires','triggers','observes'))
);
--> statement-breakpoint
ALTER TABLE "behavior_integration_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "capability_node_dependencies" (
	"org_id" text NOT NULL,
	"capability_node_id" text NOT NULL,
	"depends_on_capability_node_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_node_dependencies_org_id_capability_node_id_depends_on_capability_node_id_pk" PRIMARY KEY("org_id","capability_node_id","depends_on_capability_node_id"),
	CONSTRAINT "capability_node_dependencies_no_self_check" CHECK ("capability_node_dependencies"."capability_node_id" <> "capability_node_dependencies"."depends_on_capability_node_id")
);
--> statement-breakpoint
ALTER TABLE "capability_node_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "capability_nodes" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"environment" text NOT NULL,
	"executor_kind" text DEFAULT 'provider_operation' NOT NULL,
	"desired_state_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"wait_reason" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capability_nodes_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "capability_nodes_environment_check" CHECK ("capability_nodes"."environment" IN ('test','preview','production')),
	CONSTRAINT "capability_nodes_executor_check" CHECK ("capability_nodes"."executor_kind" IN ('provider_operation')),
	CONSTRAINT "capability_nodes_desired_hash_check" CHECK ("capability_nodes"."desired_state_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "capability_nodes_status_check" CHECK ("capability_nodes"."status" IN ('pending','enqueued','awaiting_grant','ready','needs_attention')),
	CONSTRAINT "capability_nodes_wait_reason_check" CHECK ("capability_nodes"."status" = 'awaiting_grant' OR "capability_nodes"."wait_reason" IS NULL),
	CONSTRAINT "capability_nodes_priority_check" CHECK ("capability_nodes"."priority" >= 0),
	CONSTRAINT "capability_nodes_generation_check" CHECK ("capability_nodes"."generation" >= 1)
);
--> statement-breakpoint
ALTER TABLE "capability_nodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_binding_env" (
	"org_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"key" text NOT NULL,
	"classification" text NOT NULL,
	"required" integer DEFAULT 1 NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_binding_env_org_id_binding_id_key_pk" PRIMARY KEY("org_id","binding_id","key"),
	CONSTRAINT "integration_binding_env_classification_check" CHECK ("integration_binding_env"."classification" IN ('secret','non_secret')),
	CONSTRAINT "integration_binding_env_required_check" CHECK ("integration_binding_env"."required" IN (0,1))
);
--> statement-breakpoint
ALTER TABLE "integration_binding_env" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_bindings" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"environment" text NOT NULL,
	"provider_kind" text NOT NULL,
	"adapter_version" text NOT NULL,
	"external_resource_id" text NOT NULL,
	"external_resource_name" text NOT NULL,
	"ownership" text NOT NULL,
	"teardown_policy" text NOT NULL,
	"desired_state_hash" text NOT NULL,
	"observed_state_hash" text,
	"generation" integer DEFAULT 1 NOT NULL,
	"observed_generation" integer,
	"provider_etag" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"drift_state" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_bindings_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "integration_bindings_environment_check" CHECK ("integration_bindings"."environment" IN ('test','preview','production')),
	CONSTRAINT "integration_bindings_ownership_check" CHECK ("integration_bindings"."ownership" IN ('created','adopted','shared')),
	CONSTRAINT "integration_bindings_teardown_check" CHECK ("integration_bindings"."teardown_policy" IN ('delete','retain')),
	CONSTRAINT "integration_bindings_desired_hash_check" CHECK ("integration_bindings"."desired_state_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "integration_bindings_observed_hash_check" CHECK ("integration_bindings"."observed_state_hash" IS NULL OR "integration_bindings"."observed_state_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "integration_bindings_generation_check" CHECK ("integration_bindings"."generation" >= 1),
	CONSTRAINT "integration_bindings_observed_generation_check" CHECK ("integration_bindings"."observed_generation" IS NULL OR "integration_bindings"."observed_generation" >= 1),
	CONSTRAINT "integration_bindings_status_check" CHECK ("integration_bindings"."status" IN ('pending','ready','drifted','needs_attention','retired')),
	CONSTRAINT "integration_bindings_drift_check" CHECK ("integration_bindings"."drift_state" IN ('unknown','in_sync','drifted'))
);
--> statement-breakpoint
ALTER TABLE "integration_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_requirements" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"capability" text NOT NULL,
	"plane" text NOT NULL,
	"direction" text NOT NULL,
	"desired_state" jsonb NOT NULL,
	"source_kind" text NOT NULL,
	"source_revision_id" text NOT NULL,
	"source_digest" text NOT NULL,
	"policy_version" text NOT NULL,
	"criticality" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_requirements_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "integration_requirements_plane_check" CHECK ("integration_requirements"."plane" IN ('control','product')),
	CONSTRAINT "integration_requirements_direction_check" CHECK ("integration_requirements"."direction" IN ('inbound','outbound','bidirectional')),
	CONSTRAINT "integration_requirements_source_kind_check" CHECK ("integration_requirements"."source_kind" IN ('behavior_revision','design_contract')),
	CONSTRAINT "integration_requirements_source_digest_check" CHECK ("integration_requirements"."source_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "integration_requirements_criticality_check" CHECK ("integration_requirements"."criticality" IN ('merge_required','release_required','best_effort')),
	CONSTRAINT "integration_requirements_status_check" CHECK ("integration_requirements"."status" IN ('active','superseded','needs_attention')),
	CONSTRAINT "integration_requirements_superseded_check" CHECK (("integration_requirements"."status" = 'superseded' AND "integration_requirements"."superseded_by" IS NOT NULL) OR ("integration_requirements"."status" <> 'superseded' AND "integration_requirements"."superseded_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "integration_requirements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_integration_connections" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"provider_kind" text NOT NULL,
	"upstream_account_id" text NOT NULL,
	"auth_kind" text NOT NULL,
	"credential_ref" text NOT NULL,
	"auth_generation" integer DEFAULT 1 NOT NULL,
	"owner_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"health" text DEFAULT 'unknown' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_integration_connections_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "org_integration_connections_auth_generation_check" CHECK ("org_integration_connections"."auth_generation" >= 1),
	CONSTRAINT "org_integration_connections_auth_kind_check" CHECK ("org_integration_connections"."auth_kind" IN ('api_key','oauth2','bot_token','webhook','workload_identity')),
	CONSTRAINT "org_integration_connections_health_check" CHECK ("org_integration_connections"."health" IN ('unknown','healthy','degraded','invalid')),
	CONSTRAINT "org_integration_connections_status_check" CHECK ("org_integration_connections"."status" IN ('active','revoked'))
);
--> statement-breakpoint
ALTER TABLE "org_integration_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "org_integration_grants" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"connection_id" text NOT NULL,
	"plane" text NOT NULL,
	"environment" text NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"operations" text[] DEFAULT '{}'::text[] NOT NULL,
	"provider_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"resource_constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_revision" text NOT NULL,
	"consent_revision" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_integration_grants_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "org_integration_grants_plane_check" CHECK ("org_integration_grants"."plane" IN ('control','product')),
	CONSTRAINT "org_integration_grants_environment_check" CHECK ("org_integration_grants"."environment" IN ('control','test','preview','production')),
	CONSTRAINT "org_integration_grants_plane_environment_check" CHECK (("org_integration_grants"."plane" = 'control' AND "org_integration_grants"."environment" = 'control') OR ("org_integration_grants"."plane" = 'product' AND "org_integration_grants"."environment" <> 'control')),
	CONSTRAINT "org_integration_grants_generation_check" CHECK ("org_integration_grants"."generation" >= 1),
	CONSTRAINT "org_integration_grants_status_check" CHECK ("org_integration_grants"."status" IN ('pending','active','expired','revoked')),
	CONSTRAINT "org_integration_grants_revoked_check" CHECK (("org_integration_grants"."status" = 'revoked' AND "org_integration_grants"."revoked_at" IS NOT NULL) OR ("org_integration_grants"."status" <> 'revoked' AND "org_integration_grants"."revoked_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "org_integration_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "spec_capability_dependencies" (
	"org_id" text NOT NULL,
	"spec_id" text NOT NULL,
	"capability_node_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_capability_dependencies_org_id_spec_id_capability_node_id_pk" PRIMARY KEY("org_id","spec_id","capability_node_id")
);
--> statement-breakpoint
ALTER TABLE "spec_capability_dependencies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "delivery_runs" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"authority_decision_id" text NOT NULL,
	"merge_sha" text NOT NULL,
	"binding_generations" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"retry_after" timestamp with time zone,
	"failure_classification" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "delivery_runs_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "delivery_runs_status_check" CHECK ("delivery_runs"."status" IN ('pending','claimed','running','completed','degraded','needs_attention')),
	CONSTRAINT "delivery_runs_claim_check" CHECK (("delivery_runs"."claim_owner" IS NULL AND "delivery_runs"."claim_expires_at" IS NULL) OR ("delivery_runs"."claim_owner" IS NOT NULL AND "delivery_runs"."claim_expires_at" IS NOT NULL)),
	CONSTRAINT "delivery_runs_completed_check" CHECK (("delivery_runs"."status" = 'completed' AND "delivery_runs"."completed_at" IS NOT NULL) OR ("delivery_runs"."status" <> 'completed' AND "delivery_runs"."completed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "delivery_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "delivery_stage_attempts" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"delivery_run_id" text NOT NULL,
	"stage" text NOT NULL,
	"ordinal" integer NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"failure_classification" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_stage_attempts_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "delivery_stage_attempts_stage_check" CHECK ("delivery_stage_attempts"."stage" IN ('reconcile_binding','mint_lease','materialize_env','attach_runtime','deploy','verify_deploy','stimulate','observe','record_evidence')),
	CONSTRAINT "delivery_stage_attempts_status_check" CHECK ("delivery_stage_attempts"."status" IN ('pending','claimed','running','succeeded','retry_scheduled','failed')),
	CONSTRAINT "delivery_stage_attempts_ordinal_check" CHECK ("delivery_stage_attempts"."ordinal" >= 0),
	CONSTRAINT "delivery_stage_attempts_attempt_check" CHECK ("delivery_stage_attempts"."attempt" >= 1),
	CONSTRAINT "delivery_stage_attempts_claim_check" CHECK (("delivery_stage_attempts"."claim_owner" IS NULL AND "delivery_stage_attempts"."claim_expires_at" IS NULL) OR ("delivery_stage_attempts"."claim_owner" IS NOT NULL AND "delivery_stage_attempts"."claim_expires_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "delivery_stage_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_reconciliations" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"binding_id" text,
	"phase" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"claim_owner" text,
	"claim_expires_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"progress_signature" text,
	"retry_after" timestamp with time zone,
	"failure_classification" text,
	"compensation_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_reconciliations_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "integration_reconciliations_phase_check" CHECK ("integration_reconciliations"."phase" IN ('discover','authorize','select','provision','bind','observe','materialize','reconcile','teardown')),
	CONSTRAINT "integration_reconciliations_request_fingerprint_check" CHECK ("integration_reconciliations"."request_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "integration_reconciliations_progress_signature_check" CHECK ("integration_reconciliations"."progress_signature" IS NULL OR "integration_reconciliations"."progress_signature" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "integration_reconciliations_claim_check" CHECK (("integration_reconciliations"."claim_owner" IS NULL AND "integration_reconciliations"."claim_expires_at" IS NULL) OR ("integration_reconciliations"."claim_owner" IS NOT NULL AND "integration_reconciliations"."claim_expires_at" IS NOT NULL)),
	CONSTRAINT "integration_reconciliations_status_check" CHECK ("integration_reconciliations"."status" IN ('pending','claimed','retry_scheduled','succeeded','fixed_point','state_unknown','needs_attention')),
	CONSTRAINT "integration_reconciliations_attempt_check" CHECK ("integration_reconciliations"."attempt" >= 0)
);
--> statement-breakpoint
ALTER TABLE "integration_reconciliations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_resource_snapshots" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"requirement_id" text NOT NULL,
	"binding_id" text,
	"provider_kind" text NOT NULL,
	"external_resource_id" text NOT NULL,
	"provider_cursor" text,
	"provider_etag" text,
	"observed_state_hash" text NOT NULL,
	"sanitized_snapshot" jsonb NOT NULL,
	"health" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_resource_snapshots_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "integration_resource_snapshots_hash_check" CHECK ("integration_resource_snapshots"."observed_state_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "integration_resource_snapshots_health_check" CHECK ("integration_resource_snapshots"."health" IN ('unknown','healthy','degraded','missing'))
);
--> statement-breakpoint
ALTER TABLE "integration_resource_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "integration_validation_proofs" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"spec_id" text NOT NULL,
	"behavior_revision_id" text NOT NULL,
	"behavior_verdict_id" text NOT NULL,
	"proof_unit_digest" text NOT NULL,
	"requirement_id" text NOT NULL,
	"binding_id" text NOT NULL,
	"binding_generation" integer NOT NULL,
	"delivery_run_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"deploy_sha" text NOT NULL,
	"probe_version" text NOT NULL,
	"correlation_id" text NOT NULL,
	"trigger_digest" text NOT NULL,
	"sanitized_observation" jsonb NOT NULL,
	"provider_receipt_id" text NOT NULL,
	"provider_receipt_at" timestamp with time zone NOT NULL,
	"verdict" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"signature" text NOT NULL,
	"fresh_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_validation_proofs_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "integration_validation_proofs_binding_generation_check" CHECK ("integration_validation_proofs"."binding_generation" >= 1),
	CONSTRAINT "integration_validation_proofs_trigger_digest_check" CHECK ("integration_validation_proofs"."trigger_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "integration_validation_proofs_evidence_digest_check" CHECK ("integration_validation_proofs"."evidence_digest" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "integration_validation_proofs_verdict_check" CHECK ("integration_validation_proofs"."verdict" IN ('passed','failed','degraded'))
);
--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_app_env" (
	"org_id" text NOT NULL,
	"id" text NOT NULL,
	"project_id" text NOT NULL,
	"environment" text NOT NULL,
	"key" text NOT NULL,
	"value_ref" text,
	"plain_value" text,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" text NOT NULL,
	"binding_id" text,
	"binding_generation" integer,
	"secret_generation" integer,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_app_env_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "project_app_env_environment_check" CHECK ("project_app_env"."environment" IN ('dev','test','preview','production')),
	CONSTRAINT "project_app_env_source_check" CHECK ("project_app_env"."source" IN ('byo','provisioned')),
	CONSTRAINT "project_app_env_value_xor_check" CHECK (("project_app_env"."value_ref" IS NOT NULL AND "project_app_env"."plain_value" IS NULL) OR ("project_app_env"."value_ref" IS NULL AND "project_app_env"."plain_value" IS NOT NULL)),
	CONSTRAINT "project_app_env_binding_check" CHECK (("project_app_env"."source" = 'byo' AND "project_app_env"."binding_id" IS NULL AND "project_app_env"."binding_generation" IS NULL) OR ("project_app_env"."source" = 'provisioned' AND "project_app_env"."binding_id" IS NOT NULL AND "project_app_env"."binding_generation" >= 1)),
	CONSTRAINT "project_app_env_secret_generation_check" CHECK (("project_app_env"."value_ref" IS NULL AND "project_app_env"."secret_generation" IS NULL) OR ("project_app_env"."value_ref" IS NOT NULL AND "project_app_env"."secret_generation" >= 1))
);
--> statement-breakpoint
ALTER TABLE "project_app_env" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "project_integration_grant_selections" (
	"org_id" text NOT NULL,
	"project_id" text NOT NULL,
	"provider_kind" text NOT NULL,
	"connection_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"selected_by" text NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_integration_grant_selections_org_id_project_id_provider_kind_pk" PRIMARY KEY("org_id","project_id","provider_kind")
);
--> statement-breakpoint
ALTER TABLE "project_integration_grant_selections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_integrations" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "org_integrations" CASCADE;--> statement-breakpoint
ALTER TABLE "behavior_integration_requirements" ADD CONSTRAINT "behavior_integration_requirements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behavior_integration_requirements" ADD CONSTRAINT "behavior_integration_requirements_requirement_fk" FOREIGN KEY ("org_id","requirement_id") REFERENCES "public"."integration_requirements"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "behavior_integration_requirements" ADD CONSTRAINT "behavior_integration_requirements_behavior_revision_fk" FOREIGN KEY ("org_id","behavior_revision_id") REFERENCES "public"."behavior_revisions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_node_dependencies" ADD CONSTRAINT "capability_node_dependencies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_node_dependencies" ADD CONSTRAINT "capability_node_dependencies_node_fk" FOREIGN KEY ("org_id","capability_node_id") REFERENCES "public"."capability_nodes"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_node_dependencies" ADD CONSTRAINT "capability_node_dependencies_parent_fk" FOREIGN KEY ("org_id","depends_on_capability_node_id") REFERENCES "public"."capability_nodes"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_nodes" ADD CONSTRAINT "capability_nodes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_nodes" ADD CONSTRAINT "capability_nodes_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_nodes" ADD CONSTRAINT "capability_nodes_requirement_fk" FOREIGN KEY ("org_id","requirement_id") REFERENCES "public"."integration_requirements"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_binding_env" ADD CONSTRAINT "integration_binding_env_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_binding_env" ADD CONSTRAINT "integration_binding_env_binding_fk" FOREIGN KEY ("org_id","binding_id") REFERENCES "public"."integration_bindings"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_requirement_fk" FOREIGN KEY ("org_id","requirement_id") REFERENCES "public"."integration_requirements"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_grant_fk" FOREIGN KEY ("org_id","grant_id") REFERENCES "public"."org_integration_grants"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_requirements" ADD CONSTRAINT "integration_requirements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_requirements" ADD CONSTRAINT "integration_requirements_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_requirements" ADD CONSTRAINT "integration_requirements_superseded_by_fk" FOREIGN KEY ("org_id","superseded_by") REFERENCES "public"."integration_requirements"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_integration_connections" ADD CONSTRAINT "org_integration_connections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_integration_grants" ADD CONSTRAINT "org_integration_grants_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_integration_grants" ADD CONSTRAINT "org_integration_grants_connection_fk" FOREIGN KEY ("org_id","connection_id") REFERENCES "public"."org_integration_connections"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_capability_dependencies" ADD CONSTRAINT "spec_capability_dependencies_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_capability_dependencies" ADD CONSTRAINT "spec_capability_dependencies_spec_fk" FOREIGN KEY ("org_id","spec_id") REFERENCES "public"."specs"("org_id","spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_capability_dependencies" ADD CONSTRAINT "spec_capability_dependencies_node_fk" FOREIGN KEY ("org_id","capability_node_id") REFERENCES "public"."capability_nodes"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_runs" ADD CONSTRAINT "delivery_runs_authority_decision_fk" FOREIGN KEY ("org_id","authority_decision_id") REFERENCES "public"."authority_decisions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_stage_attempts" ADD CONSTRAINT "delivery_stage_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_stage_attempts" ADD CONSTRAINT "delivery_stage_attempts_run_fk" FOREIGN KEY ("org_id","delivery_run_id") REFERENCES "public"."delivery_runs"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_reconciliations" ADD CONSTRAINT "integration_reconciliations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_reconciliations" ADD CONSTRAINT "integration_reconciliations_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_reconciliations" ADD CONSTRAINT "integration_reconciliations_requirement_fk" FOREIGN KEY ("org_id","requirement_id") REFERENCES "public"."integration_requirements"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_reconciliations" ADD CONSTRAINT "integration_reconciliations_binding_fk" FOREIGN KEY ("org_id","binding_id") REFERENCES "public"."integration_bindings"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_resource_snapshots" ADD CONSTRAINT "integration_resource_snapshots_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_resource_snapshots" ADD CONSTRAINT "integration_resource_snapshots_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_resource_snapshots" ADD CONSTRAINT "integration_resource_snapshots_requirement_fk" FOREIGN KEY ("org_id","requirement_id") REFERENCES "public"."integration_requirements"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_resource_snapshots" ADD CONSTRAINT "integration_resource_snapshots_binding_fk" FOREIGN KEY ("org_id","binding_id") REFERENCES "public"."integration_bindings"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_spec_fk" FOREIGN KEY ("org_id","spec_id") REFERENCES "public"."specs"("org_id","spec_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_behavior_revision_fk" FOREIGN KEY ("org_id","behavior_revision_id") REFERENCES "public"."behavior_revisions"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_behavior_verdict_fk" FOREIGN KEY ("org_id","behavior_verdict_id") REFERENCES "public"."behavior_verdicts"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_proof_unit_fk" FOREIGN KEY ("org_id","proof_unit_digest") REFERENCES "public"."proof_units"("org_id","proof_unit_digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_requirement_fk" FOREIGN KEY ("org_id","requirement_id") REFERENCES "public"."integration_requirements"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_binding_fk" FOREIGN KEY ("org_id","binding_id") REFERENCES "public"."integration_bindings"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_delivery_run_fk" FOREIGN KEY ("org_id","delivery_run_id") REFERENCES "public"."delivery_runs"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" ADD CONSTRAINT "integration_validation_proofs_evidence_cas_fk" FOREIGN KEY ("org_id","evidence_digest") REFERENCES "public"."cas_artifacts"("org_id","digest") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_integration_grant_selections" ADD CONSTRAINT "project_integration_grant_selections_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_integration_grant_selections" ADD CONSTRAINT "project_integration_grant_selections_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_integration_grant_selections" ADD CONSTRAINT "project_integration_grant_selections_connection_fk" FOREIGN KEY ("org_id","provider_kind","connection_id") REFERENCES "public"."org_integration_connections"("org_id","provider_kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_integration_grant_selections" ADD CONSTRAINT "project_integration_grant_selections_grant_fk" FOREIGN KEY ("org_id","connection_id","grant_id") REFERENCES "public"."org_integration_grants"("org_id","connection_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "behavior_integration_requirements_org_id" ON "behavior_integration_requirements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "behavior_integration_requirements_org_behavior" ON "behavior_integration_requirements" USING btree ("org_id","behavior_revision_id");--> statement-breakpoint
CREATE INDEX "capability_node_dependencies_org_id" ON "capability_node_dependencies" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capability_nodes_requirement_generation_unique" ON "capability_nodes" USING btree ("org_id","requirement_id","environment","generation");--> statement-breakpoint
CREATE INDEX "capability_nodes_org_id" ON "capability_nodes" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "capability_nodes_ready_order" ON "capability_nodes" USING btree ("org_id","project_id","status","priority","id");--> statement-breakpoint
CREATE INDEX "integration_binding_env_org_id" ON "integration_binding_env" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_bindings_requirement_generation_unique" ON "integration_bindings" USING btree ("org_id","requirement_id","environment","generation");--> statement-breakpoint
CREATE INDEX "integration_bindings_org_id" ON "integration_bindings" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_bindings_org_project" ON "integration_bindings" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_requirements_active_source_unique" ON "integration_requirements" USING btree ("org_id","project_id","source_kind","source_revision_id","source_digest") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "integration_requirements_org_id" ON "integration_requirements" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_requirements_org_project" ON "integration_requirements" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_integration_connections_account_unique" ON "org_integration_connections" USING btree ("org_id","provider_kind","upstream_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_integration_connections_provider_id_unique" ON "org_integration_connections" USING btree ("org_id","provider_kind","id");--> statement-breakpoint
CREATE INDEX "org_integration_connections_org_id" ON "org_integration_connections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_integration_connections_org_provider" ON "org_integration_connections" USING btree ("org_id","provider_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "org_integration_grants_generation_unique" ON "org_integration_grants" USING btree ("org_id","connection_id","plane","environment","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "org_integration_grants_connection_id_unique" ON "org_integration_grants" USING btree ("org_id","connection_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_integration_grants_active_unique" ON "org_integration_grants" USING btree ("org_id","connection_id","plane","environment") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "org_integration_grants_org_id" ON "org_integration_grants" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_integration_grants_org_connection" ON "org_integration_grants" USING btree ("org_id","connection_id");--> statement-breakpoint
CREATE INDEX "spec_capability_dependencies_org_id" ON "spec_capability_dependencies" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "spec_capability_dependencies_org_spec" ON "spec_capability_dependencies" USING btree ("org_id","spec_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_runs_authority_decision_unique" ON "delivery_runs" USING btree ("org_id","authority_decision_id");--> statement-breakpoint
CREATE INDEX "delivery_runs_org_id" ON "delivery_runs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "delivery_runs_claimable" ON "delivery_runs" USING btree ("org_id","status","retry_after","id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_stage_attempts_stage_attempt_unique" ON "delivery_stage_attempts" USING btree ("org_id","delivery_run_id","stage","attempt");--> statement-breakpoint
CREATE INDEX "delivery_stage_attempts_org_id" ON "delivery_stage_attempts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "delivery_stage_attempts_org_run" ON "delivery_stage_attempts" USING btree ("org_id","delivery_run_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_reconciliations_idempotency_unique" ON "integration_reconciliations" USING btree ("org_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "integration_reconciliations_org_id" ON "integration_reconciliations" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_reconciliations_claimable" ON "integration_reconciliations" USING btree ("org_id","status","retry_after","id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_resource_snapshots_observation_unique" ON "integration_resource_snapshots" USING btree ("org_id","provider_kind","external_resource_id","observed_state_hash");--> statement-breakpoint
CREATE INDEX "integration_resource_snapshots_org_id" ON "integration_resource_snapshots" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_resource_snapshots_org_requirement" ON "integration_resource_snapshots" USING btree ("org_id","requirement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_validation_proofs_reuse_unique" ON "integration_validation_proofs" USING btree ("org_id","behavior_revision_id","binding_id","binding_generation","deploy_sha","probe_version","correlation_id");--> statement-breakpoint
CREATE INDEX "integration_validation_proofs_org_id" ON "integration_validation_proofs" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "integration_validation_proofs_org_project" ON "integration_validation_proofs" USING btree ("org_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_integration_grant_selections_org_id" ON "project_integration_grant_selections" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "project_integration_grant_selections_org_project" ON "project_integration_grant_selections" USING btree ("org_id","project_id");--> statement-breakpoint
ALTER TABLE "project_app_env" ADD CONSTRAINT "project_app_env_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_app_env" ADD CONSTRAINT "project_app_env_project_fk" FOREIGN KEY ("org_id","project_id") REFERENCES "public"."projects"("org_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_app_env" ADD CONSTRAINT "project_app_env_binding_output_fk" FOREIGN KEY ("org_id","binding_id","key") REFERENCES "public"."integration_binding_env"("org_id","binding_id","key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_app_env_project_environment_key_unique" ON "project_app_env" USING btree ("org_id","project_id","environment","key");--> statement-breakpoint
CREATE INDEX "project_app_env_org_id" ON "project_app_env" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "project_app_env_org_project" ON "project_app_env" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_org_project_unique" ON "projects" USING btree ("org_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "specs_org_spec_unique" ON "specs" USING btree ("org_id","spec_id");--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "project_app_env" AS PERMISSIVE FOR ALL TO public USING ("project_app_env"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("project_app_env"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "behavior_integration_requirements" AS PERMISSIVE FOR ALL TO public USING ("behavior_integration_requirements"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("behavior_integration_requirements"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "capability_node_dependencies" AS PERMISSIVE FOR ALL TO public USING ("capability_node_dependencies"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("capability_node_dependencies"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "capability_nodes" AS PERMISSIVE FOR ALL TO public USING ("capability_nodes"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("capability_nodes"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_binding_env" AS PERMISSIVE FOR ALL TO public USING ("integration_binding_env"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_binding_env"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_bindings" AS PERMISSIVE FOR ALL TO public USING ("integration_bindings"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_bindings"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_requirements" AS PERMISSIVE FOR ALL TO public USING ("integration_requirements"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_requirements"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "org_integration_connections" AS PERMISSIVE FOR ALL TO public USING ("org_integration_connections"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("org_integration_connections"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "org_integration_grants" AS PERMISSIVE FOR ALL TO public USING ("org_integration_grants"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("org_integration_grants"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "spec_capability_dependencies" AS PERMISSIVE FOR ALL TO public USING ("spec_capability_dependencies"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("spec_capability_dependencies"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "delivery_runs" AS PERMISSIVE FOR ALL TO public USING ("delivery_runs"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("delivery_runs"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "delivery_stage_attempts" AS PERMISSIVE FOR ALL TO public USING ("delivery_stage_attempts"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("delivery_stage_attempts"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_reconciliations" AS PERMISSIVE FOR ALL TO public USING ("integration_reconciliations"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_reconciliations"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_resource_snapshots" AS PERMISSIVE FOR ALL TO public USING ("integration_resource_snapshots"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_resource_snapshots"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "integration_validation_proofs" AS PERMISSIVE FOR ALL TO public USING ("integration_validation_proofs"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("integration_validation_proofs"."org_id" = current_setting('app.current_org_id', true));--> statement-breakpoint
CREATE POLICY "rls_org_isolation" ON "project_integration_grant_selections" AS PERMISSIVE FOR ALL TO public USING ("project_integration_grant_selections"."org_id" = current_setting('app.current_org_id', true)) WITH CHECK ("project_integration_grant_selections"."org_id" = current_setting('app.current_org_id', true));
--> statement-breakpoint
-- drizzle-kit models ENABLE + policy metadata in the snapshot but not FORCE.
-- FORCE remains the sole hand-authored RLS extension.
ALTER TABLE "behavior_integration_requirements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capability_node_dependencies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "capability_nodes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_binding_env" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_bindings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_requirements" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_integration_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_integration_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "spec_capability_dependencies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "delivery_stage_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_reconciliations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_resource_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integration_validation_proofs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_app_env" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "project_integration_grant_selections" FORCE ROW LEVEL SECURITY;
