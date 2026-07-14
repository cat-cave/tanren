CREATE TABLE behavior_verification_plans (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  behavior_revision_id text NOT NULL,
  design_contract_id text,
  compiler_version text NOT NULL,
  plan_hash text NOT NULL,
  status text NOT NULL,
  plan_json jsonb NOT NULL,
  unresolved_capabilities jsonb NOT NULL,
  provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behavior_verification_plans_pk PRIMARY KEY (org_id, id),
  CONSTRAINT behavior_verification_plans_status_check CHECK (status IN ('compiled', 'needs_respec', 'missing_fragments')),
  CONSTRAINT behavior_verification_plans_plan_hash_check CHECK (plan_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT behavior_verification_plans_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT behavior_verification_plans_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT behavior_verification_plans_behavior_revision_fk FOREIGN KEY (org_id, behavior_revision_id) REFERENCES behavior_revisions(org_id, id),
  CONSTRAINT behavior_verification_plans_design_contract_fk FOREIGN KEY (design_contract_id) REFERENCES design_contracts(id)
);
--> statement-breakpoint
CREATE INDEX behavior_verification_plans_org_id ON behavior_verification_plans (org_id);
--> statement-breakpoint
CREATE INDEX behavior_verification_plans_org_project ON behavior_verification_plans (org_id, project_id);
--> statement-breakpoint
ALTER TABLE behavior_verification_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE behavior_verification_plans FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behavior_verification_plans;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behavior_verification_plans FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE verification_fragments (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  capability_key text NOT NULL,
  fragment_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_fragments_pk PRIMARY KEY (org_id, id),
  CONSTRAINT verification_fragments_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT verification_fragments_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id)
);
--> statement-breakpoint
CREATE INDEX verification_fragments_org_id ON verification_fragments (org_id);
--> statement-breakpoint
CREATE INDEX verification_fragments_org_project ON verification_fragments (org_id, project_id);
--> statement-breakpoint
ALTER TABLE verification_fragments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE verification_fragments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON verification_fragments;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON verification_fragments FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE verification_fragment_versions (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  fragment_id text NOT NULL,
  source_path text NOT NULL,
  jj_change_id text NOT NULL,
  jj_tree_id text NOT NULL,
  content_hash text NOT NULL,
  contract_version text NOT NULL,
  conformance_status text NOT NULL,
  superseded_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_fragment_versions_pk PRIMARY KEY (org_id, id),
  CONSTRAINT verification_fragment_versions_content_hash_check CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT verification_fragment_versions_conformance_check CHECK (conformance_status IN ('pending', 'passed', 'failed')),
  CONSTRAINT verification_fragment_versions_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT verification_fragment_versions_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT verification_fragment_versions_fragment_fk FOREIGN KEY (org_id, fragment_id) REFERENCES verification_fragments(org_id, id),
  CONSTRAINT verification_fragment_versions_superseded_fk FOREIGN KEY (org_id, superseded_by) REFERENCES verification_fragment_versions(org_id, id)
);
--> statement-breakpoint
CREATE INDEX verification_fragment_versions_org_id ON verification_fragment_versions (org_id);
--> statement-breakpoint
CREATE INDEX verification_fragment_versions_org_project ON verification_fragment_versions (org_id, project_id);
--> statement-breakpoint
ALTER TABLE verification_fragment_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE verification_fragment_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON verification_fragment_versions;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON verification_fragment_versions FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE verification_plan_fragments (
  org_id text NOT NULL,
  plan_id text NOT NULL,
  step_id text NOT NULL,
  fragment_version_id text NOT NULL,
  project_id text NOT NULL,
  source_span text NOT NULL,
  CONSTRAINT verification_plan_fragments_pk PRIMARY KEY (org_id, plan_id, step_id, fragment_version_id),
  CONSTRAINT verification_plan_fragments_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT verification_plan_fragments_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT verification_plan_fragments_plan_fk FOREIGN KEY (org_id, plan_id) REFERENCES behavior_verification_plans(org_id, id),
  CONSTRAINT verification_plan_fragments_fragment_version_fk FOREIGN KEY (org_id, fragment_version_id) REFERENCES verification_fragment_versions(org_id, id)
);
--> statement-breakpoint
CREATE INDEX verification_plan_fragments_org_id ON verification_plan_fragments (org_id);
--> statement-breakpoint
CREATE INDEX verification_plan_fragments_org_project ON verification_plan_fragments (org_id, project_id);
--> statement-breakpoint
ALTER TABLE verification_plan_fragments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE verification_plan_fragments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON verification_plan_fragments;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON verification_plan_fragments FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE behavior_coverage_edges (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  behavior_revision_id text NOT NULL,
  edge_kind text NOT NULL,
  target_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behavior_coverage_edges_pk PRIMARY KEY (org_id, id),
  CONSTRAINT behavior_coverage_edges_kind_check CHECK (edge_kind IN ('spec', 'source', 'component', 'integration', 'design', 'dependency')),
  CONSTRAINT behavior_coverage_edges_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT behavior_coverage_edges_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT behavior_coverage_edges_behavior_revision_fk FOREIGN KEY (org_id, behavior_revision_id) REFERENCES behavior_revisions(org_id, id)
);
--> statement-breakpoint
CREATE INDEX behavior_coverage_edges_org_id ON behavior_coverage_edges (org_id);
--> statement-breakpoint
CREATE INDEX behavior_coverage_edges_org_project ON behavior_coverage_edges (org_id, project_id);
--> statement-breakpoint
ALTER TABLE behavior_coverage_edges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE behavior_coverage_edges FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behavior_coverage_edges;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behavior_coverage_edges FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE verification_environments (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  integration_node_id text NOT NULL,
  artifact_digest text NOT NULL,
  deployment_target text NOT NULL,
  environment_fingerprint text NOT NULL,
  tenant_lease_id text NOT NULL,
  lifecycle_status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_environments_pk PRIMARY KEY (org_id, id),
  CONSTRAINT verification_environments_artifact_digest_check CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT verification_environments_lifecycle_check CHECK (lifecycle_status IN ('provisioning', 'ready', 'torn_down', 'failed')),
  CONSTRAINT verification_environments_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT verification_environments_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT verification_environments_integration_node_fk FOREIGN KEY (integration_node_id) REFERENCES integration_nodes(node_id),
  CONSTRAINT verification_environments_artifact_fk FOREIGN KEY (org_id, artifact_digest) REFERENCES cas_artifacts(org_id, digest)
);
--> statement-breakpoint
CREATE INDEX verification_environments_org_id ON verification_environments (org_id);
--> statement-breakpoint
CREATE INDEX verification_environments_org_project ON verification_environments (org_id, project_id);
--> statement-breakpoint
ALTER TABLE verification_environments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE verification_environments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON verification_environments;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON verification_environments FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE behavior_verification_runs (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  purpose text NOT NULL,
  run_id text,
  spec_id text,
  integration_node_id text,
  environment_id text NOT NULL,
  prepared_head_sha text NOT NULL,
  jj_tree_id text NOT NULL,
  plan_set_hash text NOT NULL,
  runtime_behavior_context_hash text NOT NULL,
  artifact_digest text NOT NULL,
  status text NOT NULL,
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behavior_verification_runs_pk PRIMARY KEY (org_id, id),
  CONSTRAINT behavior_verification_runs_purpose_check CHECK (purpose IN ('per_iteration', 'pre_audit', 'pre_merge', 'release_periodic', 'post_merge_production', 'manual_canary')),
  CONSTRAINT behavior_verification_runs_plan_set_hash_check CHECK (plan_set_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT behavior_verification_runs_context_hash_check CHECK (runtime_behavior_context_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT behavior_verification_runs_artifact_digest_check CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT behavior_verification_runs_status_check CHECK (status IN ('planned', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT behavior_verification_runs_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT behavior_verification_runs_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT behavior_verification_runs_run_fk FOREIGN KEY (run_id) REFERENCES runs(run_id),
  CONSTRAINT behavior_verification_runs_integration_node_fk FOREIGN KEY (integration_node_id) REFERENCES integration_nodes(node_id),
  CONSTRAINT behavior_verification_runs_environment_fk FOREIGN KEY (org_id, environment_id) REFERENCES verification_environments(org_id, id),
  CONSTRAINT behavior_verification_runs_artifact_fk FOREIGN KEY (org_id, artifact_digest) REFERENCES cas_artifacts(org_id, digest)
);
--> statement-breakpoint
CREATE INDEX behavior_verification_runs_org_id ON behavior_verification_runs (org_id);
--> statement-breakpoint
CREATE INDEX behavior_verification_runs_org_project ON behavior_verification_runs (org_id, project_id);
--> statement-breakpoint
ALTER TABLE behavior_verification_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE behavior_verification_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behavior_verification_runs;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behavior_verification_runs FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE behavior_verification_attempts (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  behavior_revision_id text NOT NULL,
  plan_id text NOT NULL,
  example_hash text NOT NULL,
  matrix_hash text NOT NULL,
  shard integer NOT NULL,
  seed text NOT NULL,
  replay_of text,
  outcome text NOT NULL,
  classification text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  failure_signature text,
  artifact_manifest_digest text,
  CONSTRAINT behavior_verification_attempts_pk PRIMARY KEY (org_id, id),
  CONSTRAINT behavior_verification_attempts_outcome_check CHECK (outcome IN ('passed', 'failed_product', 'failed_verification_contract', 'failed_visual', 'inconclusive_infrastructure', 'inconclusive_external', 'cancelled_superseded')),
  CONSTRAINT behavior_verification_attempts_artifact_manifest_check CHECK (artifact_manifest_digest IS NULL OR artifact_manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT behavior_verification_attempts_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT behavior_verification_attempts_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT behavior_verification_attempts_run_fk FOREIGN KEY (org_id, run_id) REFERENCES behavior_verification_runs(org_id, id),
  CONSTRAINT behavior_verification_attempts_behavior_revision_fk FOREIGN KEY (org_id, behavior_revision_id) REFERENCES behavior_revisions(org_id, id),
  CONSTRAINT behavior_verification_attempts_plan_fk FOREIGN KEY (org_id, plan_id) REFERENCES behavior_verification_plans(org_id, id),
  CONSTRAINT behavior_verification_attempts_replay_fk FOREIGN KEY (org_id, replay_of) REFERENCES behavior_verification_attempts(org_id, id)
);
--> statement-breakpoint
CREATE INDEX behavior_verification_attempts_org_id ON behavior_verification_attempts (org_id);
--> statement-breakpoint
CREATE INDEX behavior_verification_attempts_org_project ON behavior_verification_attempts (org_id, project_id);
--> statement-breakpoint
ALTER TABLE behavior_verification_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE behavior_verification_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behavior_verification_attempts;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behavior_verification_attempts FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE behavior_verdicts (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  run_id text NOT NULL,
  behavior_revision_id text NOT NULL,
  example_hash text NOT NULL,
  matrix_hash text NOT NULL,
  required_assertion_count integer NOT NULL,
  executed_assertion_count integer NOT NULL,
  outcome text NOT NULL,
  attempt_count integer NOT NULL,
  flake_state text NOT NULL,
  gate_effect text NOT NULL,
  artifact_digest text NOT NULL,
  proof_unit_digest text,
  runtime_behavior_context_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behavior_verdicts_pk PRIMARY KEY (org_id, id),
  CONSTRAINT behavior_verdicts_executed_count_check CHECK (executed_assertion_count >= 0),
  CONSTRAINT behavior_verdicts_required_count_check CHECK (required_assertion_count >= 0),
  CONSTRAINT behavior_verdicts_attempt_count_check CHECK (attempt_count >= 0),
  CONSTRAINT behavior_verdicts_outcome_check CHECK (outcome IN ('passed', 'failed_product', 'failed_verification_contract', 'failed_visual', 'inconclusive_infrastructure', 'inconclusive_external', 'cancelled_superseded')),
  CONSTRAINT behavior_verdicts_flake_state_check CHECK (flake_state IN ('stable', 'suspected', 'confirmed', 'quarantined_fragment')),
  CONSTRAINT behavior_verdicts_gate_effect_check CHECK (gate_effect IN ('blocking', 'advisory')),
  CONSTRAINT behavior_verdicts_artifact_digest_check CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT behavior_verdicts_proof_unit_digest_check CHECK (proof_unit_digest IS NULL OR proof_unit_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT behavior_verdicts_context_hash_check CHECK (runtime_behavior_context_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT behavior_verdicts_pass_requires_execution CHECK (outcome <> 'passed' OR executed_assertion_count > 0),
  CONSTRAINT behavior_verdicts_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT behavior_verdicts_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT behavior_verdicts_run_fk FOREIGN KEY (org_id, run_id) REFERENCES behavior_verification_runs(org_id, id),
  CONSTRAINT behavior_verdicts_behavior_revision_fk FOREIGN KEY (org_id, behavior_revision_id) REFERENCES behavior_revisions(org_id, id),
  CONSTRAINT behavior_verdicts_artifact_fk FOREIGN KEY (org_id, artifact_digest) REFERENCES cas_artifacts(org_id, digest),
  CONSTRAINT behavior_verdicts_proof_unit_fk FOREIGN KEY (org_id, proof_unit_digest) REFERENCES proof_units(org_id, proof_unit_digest)
);
--> statement-breakpoint
CREATE INDEX behavior_verdicts_org_id ON behavior_verdicts (org_id);
--> statement-breakpoint
CREATE INDEX behavior_verdicts_org_project ON behavior_verdicts (org_id, project_id);
--> statement-breakpoint
ALTER TABLE behavior_verdicts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE behavior_verdicts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behavior_verdicts;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behavior_verdicts FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE behavior_assertion_observations (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  attempt_id text NOT NULL,
  assertion_kind text NOT NULL,
  comparison_operator text NOT NULL,
  expected_json jsonb NOT NULL,
  actual_json jsonb NOT NULL,
  temporal_semantics text NOT NULL,
  redaction_class text NOT NULL,
  passed boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behavior_assertion_observations_pk PRIMARY KEY (org_id, id),
  CONSTRAINT behavior_assertion_observations_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT behavior_assertion_observations_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT behavior_assertion_observations_attempt_fk FOREIGN KEY (org_id, attempt_id) REFERENCES behavior_verification_attempts(org_id, id)
);
--> statement-breakpoint
CREATE INDEX behavior_assertion_observations_org_id ON behavior_assertion_observations (org_id);
--> statement-breakpoint
CREATE INDEX behavior_assertion_observations_org_project ON behavior_assertion_observations (org_id, project_id);
--> statement-breakpoint
ALTER TABLE behavior_assertion_observations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE behavior_assertion_observations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behavior_assertion_observations;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behavior_assertion_observations FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE behavior_effect_observations (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  attempt_id text NOT NULL,
  trigger_id_hash text NOT NULL,
  observer_provider text NOT NULL,
  provider_object_hash text NOT NULL,
  cursor_watermark text NOT NULL,
  occurrence_count integer NOT NULL,
  latency_ms integer,
  duplicate_classification text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behavior_effect_observations_pk PRIMARY KEY (org_id, id),
  CONSTRAINT behavior_effect_observations_occurrence_check CHECK (occurrence_count >= 0),
  CONSTRAINT behavior_effect_observations_duplicate_check CHECK (duplicate_classification IN ('unique', 'duplicate', 'missing')),
  CONSTRAINT behavior_effect_observations_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT behavior_effect_observations_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT behavior_effect_observations_attempt_fk FOREIGN KEY (org_id, attempt_id) REFERENCES behavior_verification_attempts(org_id, id)
);
--> statement-breakpoint
CREATE INDEX behavior_effect_observations_org_id ON behavior_effect_observations (org_id);
--> statement-breakpoint
CREATE INDEX behavior_effect_observations_org_project ON behavior_effect_observations (org_id, project_id);
--> statement-breakpoint
ALTER TABLE behavior_effect_observations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE behavior_effect_observations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behavior_effect_observations;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behavior_effect_observations FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE verification_artifacts (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  cas_digest text NOT NULL,
  proof_unit_digest text,
  kind text NOT NULL,
  media_type text NOT NULL,
  byte_size bigint NOT NULL,
  redaction_class text NOT NULL,
  retention_class text NOT NULL,
  producing_attempt_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verification_artifacts_pk PRIMARY KEY (org_id, id),
  CONSTRAINT verification_artifacts_cas_digest_check CHECK (cas_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT verification_artifacts_proof_unit_digest_check CHECK (proof_unit_digest IS NULL OR proof_unit_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT verification_artifacts_byte_size_check CHECK (byte_size >= 0),
  CONSTRAINT verification_artifacts_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT verification_artifacts_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT verification_artifacts_cas_fk FOREIGN KEY (org_id, cas_digest) REFERENCES cas_artifacts(org_id, digest),
  CONSTRAINT verification_artifacts_proof_unit_fk FOREIGN KEY (org_id, proof_unit_digest) REFERENCES proof_units(org_id, proof_unit_digest),
  CONSTRAINT verification_artifacts_attempt_fk FOREIGN KEY (org_id, producing_attempt_id) REFERENCES behavior_verification_attempts(org_id, id)
);
--> statement-breakpoint
CREATE INDEX verification_artifacts_org_id ON verification_artifacts (org_id);
--> statement-breakpoint
CREATE INDEX verification_artifacts_org_project ON verification_artifacts (org_id, project_id);
--> statement-breakpoint
ALTER TABLE verification_artifacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE verification_artifacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON verification_artifacts;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON verification_artifacts FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE design_render_verdicts (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  behavior_revision_id text NOT NULL,
  design_contract_id text NOT NULL,
  checkpoint_key text NOT NULL,
  matrix_hash text NOT NULL,
  actual_digest text NOT NULL,
  baseline_digest text,
  diff_digest text,
  dom_digest text,
  a11y_digest text,
  rule_results jsonb NOT NULL,
  outcome text NOT NULL,
  design_oracle_finding_ref text,
  proof_unit_digest text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT design_render_verdicts_pk PRIMARY KEY (org_id, id),
  CONSTRAINT design_render_verdicts_actual_digest_check CHECK (actual_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT design_render_verdicts_baseline_digest_check CHECK (baseline_digest IS NULL OR baseline_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT design_render_verdicts_diff_digest_check CHECK (diff_digest IS NULL OR diff_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT design_render_verdicts_dom_digest_check CHECK (dom_digest IS NULL OR dom_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT design_render_verdicts_a11y_digest_check CHECK (a11y_digest IS NULL OR a11y_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT design_render_verdicts_proof_unit_digest_check CHECK (proof_unit_digest IS NULL OR proof_unit_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT design_render_verdicts_outcome_check CHECK (outcome IN ('passed', 'failed_visual', 'inconclusive_infrastructure')),
  CONSTRAINT design_render_verdicts_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT design_render_verdicts_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT design_render_verdicts_behavior_revision_fk FOREIGN KEY (org_id, behavior_revision_id) REFERENCES behavior_revisions(org_id, id),
  CONSTRAINT design_render_verdicts_design_contract_fk FOREIGN KEY (design_contract_id) REFERENCES design_contracts(id),
  CONSTRAINT design_render_verdicts_actual_fk FOREIGN KEY (org_id, actual_digest) REFERENCES cas_artifacts(org_id, digest),
  CONSTRAINT design_render_verdicts_baseline_fk FOREIGN KEY (org_id, baseline_digest) REFERENCES cas_artifacts(org_id, digest),
  CONSTRAINT design_render_verdicts_diff_fk FOREIGN KEY (org_id, diff_digest) REFERENCES cas_artifacts(org_id, digest),
  CONSTRAINT design_render_verdicts_dom_fk FOREIGN KEY (org_id, dom_digest) REFERENCES cas_artifacts(org_id, digest),
  CONSTRAINT design_render_verdicts_a11y_fk FOREIGN KEY (org_id, a11y_digest) REFERENCES cas_artifacts(org_id, digest),
  CONSTRAINT design_render_verdicts_proof_unit_fk FOREIGN KEY (org_id, proof_unit_digest) REFERENCES proof_units(org_id, proof_unit_digest)
);
--> statement-breakpoint
CREATE INDEX design_render_verdicts_org_id ON design_render_verdicts (org_id);
--> statement-breakpoint
CREATE INDEX design_render_verdicts_org_project ON design_render_verdicts (org_id, project_id);
--> statement-breakpoint
ALTER TABLE design_render_verdicts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE design_render_verdicts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON design_render_verdicts;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON design_render_verdicts FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
--> statement-breakpoint

CREATE TABLE behavior_quarantines (
  org_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  behavior_revision_id text NOT NULL,
  fragment_version_id text,
  matrix_scope text NOT NULL,
  evidence_ref text NOT NULL,
  owner text NOT NULL,
  reason text NOT NULL,
  expiry timestamptz NOT NULL,
  exit_criteria text NOT NULL,
  replacement_proof_verdict_id text,
  repair_spec_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behavior_quarantines_pk PRIMARY KEY (org_id, id),
  CONSTRAINT behavior_quarantines_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id),
  CONSTRAINT behavior_quarantines_project_fk FOREIGN KEY (project_id) REFERENCES projects(project_id),
  CONSTRAINT behavior_quarantines_behavior_revision_fk FOREIGN KEY (org_id, behavior_revision_id) REFERENCES behavior_revisions(org_id, id),
  CONSTRAINT behavior_quarantines_fragment_version_fk FOREIGN KEY (org_id, fragment_version_id) REFERENCES verification_fragment_versions(org_id, id),
  CONSTRAINT behavior_quarantines_replacement_verdict_fk FOREIGN KEY (org_id, replacement_proof_verdict_id) REFERENCES behavior_verdicts(org_id, id)
);
--> statement-breakpoint
CREATE INDEX behavior_quarantines_org_id ON behavior_quarantines (org_id);
--> statement-breakpoint
CREATE INDEX behavior_quarantines_org_project ON behavior_quarantines (org_id, project_id);
--> statement-breakpoint
ALTER TABLE behavior_quarantines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE behavior_quarantines FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS rls_org_isolation ON behavior_quarantines;
--> statement-breakpoint
CREATE POLICY rls_org_isolation ON behavior_quarantines FOR ALL USING (org_id = current_setting('app.current_org_id', true)) WITH CHECK (org_id = current_setting('app.current_org_id', true));
