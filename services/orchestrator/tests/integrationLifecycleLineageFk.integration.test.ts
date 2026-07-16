// cspell:ignore supersedes
/**
 * IN-1 same-org cross-project lineage repair — real-Postgres proof.
 *
 * Governing rule: for every relationship whose endpoints have project identity,
 * the child row has one shared `project_id` and every endpoint FK includes that
 * same column. Org RLS is NOT same-org referential integrity: a Project-A row
 * must not be able to cite a Project-B endpoint just because both live in one org.
 *
 * For every edge family below, this seeds one org with Projects A and B, proves a
 * same-project control insert succeeds, and proves a swap to the other project's
 * endpoint fails with an FK violation. Wrong-org/grant-selection negatives live in
 * integrationLifecycleMigrationOrder; they do not replace these two-project ones.
 *
 * Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL. Compiles
 * and describe.skip when the gate is off (same harness as the RLS suite).
 */
import { migrate } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";

const ORG = "org_in_lineage_fk";
const PROJECT_A = "project_lineage_a";
const PROJECT_B = "project_lineage_b";
const D = `sha256:${"c".repeat(64)}`; // generic sha256 digest
const CAS_A = `sha256:${"a".repeat(64)}`; // per-project cas artifact / proof unit digest
const CAS_B = `sha256:${"b".repeat(64)}`;

function dbName(): string {
  return `tanren_in_lineage_fk_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

interface Lineage {
  spec: string;
  behaviorRevision: string;
  personaRevision: string;
  verdict: string;
  proofUnit: string;
  authorityDecision: string;
  requirement: string;
  capabilityNode: string;
  capabilityNode2: string;
  connection: string;
  grant: string;
  binding: string;
  generation: number;
  envKey: string;
  deliveryRun: string;
  integrationNode: string;
}

async function seedLineage(
  owner: Pool,
  org: string,
  project: string,
  tag: string,
  casDigest: string,
): Promise<Lineage> {
  const id = (s: string) => `${s}_${tag}`;
  const L: Lineage = {
    spec: id("spec"),
    behaviorRevision: id("br"),
    personaRevision: id("pr"),
    verdict: id("bv"),
    proofUnit: casDigest,
    authorityDecision: id("ad"),
    requirement: id("req"),
    capabilityNode: id("node"),
    capabilityNode2: id("node2"),
    connection: id("conn"),
    grant: id("grant"),
    binding: id("binding"),
    generation: 1,
    envKey: id("key"),
    deliveryRun: id("run"),
    integrationNode: id("inode"),
  };

  // integration_node (FK target for verification_environment + authority_decision).
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', $5)`,
    [L.integrationNode, project, org, D, `member-key-${tag}`],
  );
  // cas_artifact (proof_unit + verification evidence + verdict artifact share one digest per project).
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes) VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [org, casDigest, Buffer.from([0])],
  );
  // spec.
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, depends_on)
     VALUES ($1, $2, $3, $4, $4, '{}'::text[])`,
    [L.spec, project, org, tag],
  );
  // persona + behavior revision (project-scoped so the composite FK can cite it).
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, $4, 'project', 1, $4, $4, $5)`,
    [L.personaRevision, org, project, tag, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest)
     VALUES ($1, $2, $3, $4, $5, 1, $4, 'g', 'w', 't', $6)`,
    [L.behaviorRevision, org, project, tag, L.personaRevision, D],
  );
  // proof unit (digest FKs to this project's cas artifact).
  await owner.query(
    `INSERT INTO proof_units (org_id, project_id, proof_unit_digest, kind, verdict, subject_id)
     VALUES ($1, $2, $3, 'test', 'passed', $4)`,
    [org, project, casDigest, tag],
  );
  // verification environment + run + verdict (artifact_digest FKs to the cas artifact).
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [org, id("venv"), project, L.integrationNode, casDigest, D],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, $2, $3, 'manual_canary', $4, $5, $5, $5, $5, $6, 'completed', '{}'::jsonb)`,
    [org, id("vrun"), project, id("venv"), D, casDigest],
  );
  await owner.query(
    `INSERT INTO behavior_verdicts (org_id, id, project_id, run_id, behavior_revision_id, example_hash, matrix_hash, required_assertion_count, executed_assertion_count, outcome, attempt_count, flake_state, gate_effect, artifact_digest, runtime_behavior_context_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 1, 1, 'passed', 1, 'stable', 'blocking', $7, $6)`,
    [org, L.verdict, project, id("vrun"), L.behaviorRevision, D, casDigest],
  );
  // authority decision.
  await owner.query(
    `INSERT INTO authority_decisions (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha, artifact_digest, proof_root, member_set_hash, policy_version, decision)
     VALUES ($1, $2, $3, $4, 'integration_node', $5, $5, $5, $5, $5, 'v1', 'authorized')`,
    [org, project, L.authorityDecision, L.integrationNode, D],
  );
  // integration requirement.
  await owner.query(
    `INSERT INTO integration_requirements (org_id, id, project_id, capability, plane, direction, desired_state, source_kind, source_revision_id, source_digest, policy_version, criticality)
     VALUES ($1, $2, $3, 'errors', 'product', 'outbound', '{}'::jsonb, 'behavior_revision', $4, $5, 'v1', 'release_required')`,
    [org, L.requirement, project, tag, D],
  );
  // capability node.
  await owner.query(
    `INSERT INTO capability_nodes (org_id, id, project_id, requirement_id, environment, desired_state_hash)
     VALUES ($1, $2, $3, $4, 'production', $5)`,
    [org, L.capabilityNode, project, L.requirement, D],
  );
  await owner.query(
    `INSERT INTO capability_nodes (org_id, id, project_id, requirement_id, environment, desired_state_hash)
     VALUES ($1, $2, $3, $4, 'preview', $5)`,
    [org, L.capabilityNode2, project, L.requirement, D],
  );
  // connection + auth gen + grant + grant gen (exact-generation binding lineage).
  await owner.query(
    `INSERT INTO org_integration_connections (org_id, id, provider_kind, provider_principal_id, principal_kind, display_name, owner_id)
     VALUES ($1, $2, 'sentry', $3, 'organization', $3, 'owner')`,
    [org, L.connection, tag],
  );
  await owner.query(
    `INSERT INTO org_integration_connection_auth_generations (org_id, provider_kind, connection_id, generation, credential_ref, auth_kind, status)
     VALUES ($1, 'sentry', $2, 1, $3, 'api_key', 'active')`,
    [org, L.connection, `secret://${L.connection}`],
  );
  await owner.query(
    `INSERT INTO org_integration_grants (org_id, id, provider_kind, connection_id, plane, environment, current_generation, status)
     VALUES ($1, $2, 'sentry', $3, 'product', 'production', 1, 'active')`,
    [org, L.grant, L.connection],
  );
  await owner.query(
    `INSERT INTO org_integration_grant_generations (org_id, provider_kind, connection_id, grant_id, generation, capabilities, operations, provider_scopes, policy_revision, consent_revision, consent_actor_id, consented_at, status)
     VALUES ($1, 'sentry', $2, $3, 1, '{errors}', '{provision}', '{project:write}', 'v1', 'c', 'owner', now(), 'active')`,
    [org, L.connection, L.grant],
  );
  // binding + binding generation.
  await owner.query(
    `INSERT INTO integration_bindings (org_id, id, project_id, requirement_id, environment, provider_kind, connection_id)
     VALUES ($1, $2, $3, $4, 'production', 'sentry', $5)`,
    [org, L.binding, project, L.requirement, L.connection],
  );
  await owner.query(
    `INSERT INTO integration_binding_generations (org_id, project_id, requirement_id, environment, binding_id, generation, provider_kind, connection_id, auth_generation, grant_id, grant_generation, adapter_version, external_resource_id, external_resource_name, ownership, teardown_policy, desired_state_hash)
     VALUES ($1, $2, $3, $4, $5, 1, 'sentry', $6, 1, $7, 1, 'v1', $8, $8, 'created', 'delete', $9)`,
    [org, project, L.requirement, "production", L.binding, L.connection, L.grant, tag, D],
  );
  // binding env output.
  await owner.query(
    `INSERT INTO integration_binding_env (org_id, project_id, binding_id, binding_generation, key, classification)
     VALUES ($1, $2, $3, 1, $4, 'non_secret')`,
    [org, project, L.binding, L.envKey],
  );
  // delivery run (cites the authority decision).
  await owner.query(
    `INSERT INTO delivery_runs (org_id, id, project_id, authority_decision_id, merge_sha)
     VALUES ($1, $2, $3, $4, $5)`,
    [org, L.deliveryRun, project, L.authorityDecision, D],
  );
  return L;
}

describeDb("IN-1 same-org lineage repair — rejects cross-project endpoints", () => {
  const database = dbName();
  let owner: Pool;
  let A: Lineage;
  let B: Lineage;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(owner);
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config) VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    for (const project of [PROJECT_A, PROJECT_B]) {
      await owner.query(
        `INSERT INTO projects (project_id, name, repo_url, org_id) VALUES ($1, $1, 'https://example.com/repo.git', $2)`,
        [project, ORG],
      );
    }
    A = await seedLineage(owner, ORG, PROJECT_A, "a", CAS_A);
    B = await seedLineage(owner, ORG, PROJECT_B, "b", CAS_B);
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  const fkError = /foreign key|violates/iu;

  // ---- Edge 1: requirement supersession (same-project only) ----
  it("rejects a supersession that points at another project's requirement", async () => {
    await owner.query(
      `UPDATE integration_requirements SET status='superseded', superseded_by=$3 WHERE org_id=$1 AND id=$2`,
      [ORG, A.requirement, A.requirement],
    );
    await expect(
      owner.query(`UPDATE integration_requirements SET superseded_by=$3 WHERE org_id=$1 AND id=$2`, [
        ORG,
        A.requirement,
        B.requirement,
      ]),
    ).rejects.toThrow(fkError);
  });

  // ---- Edge 2: behavior↔requirement (both endpoints, shared project_id) ----
  it("rejects a Project-A behavior↔requirement row citing Project-B on either endpoint", async () => {
    // control: both endpoints Project A.
    await owner.query(
      `INSERT INTO behavior_integration_requirements (org_id, project_id, behavior_revision_id, requirement_id)
       VALUES ($1, $2, $3, $4)`,
      [ORG, PROJECT_A, A.behaviorRevision, A.requirement],
    );
    // requirement endpoint swapped to Project B.
    await expect(
      owner.query(
        `INSERT INTO behavior_integration_requirements (org_id, project_id, behavior_revision_id, requirement_id)
         VALUES ($1, $2, $3, $4)`,
        [ORG, PROJECT_A, A.behaviorRevision, B.requirement],
      ),
    ).rejects.toThrow(fkError);
    // behavior revision endpoint swapped to Project B.
    await expect(
      owner.query(
        `INSERT INTO behavior_integration_requirements (org_id, project_id, behavior_revision_id, requirement_id)
         VALUES ($1, $2, $3, $4)`,
        [ORG, PROJECT_A, B.behaviorRevision, A.requirement],
      ),
    ).rejects.toThrow(fkError);
  });

  // ---- Edges 3-4: capability node↔node dependency (both node endpoints) ----
  it("rejects a capability node dependency whose either node endpoint is another project", async () => {
    await owner.query(
      `INSERT INTO capability_node_dependencies (org_id, project_id, capability_node_id, depends_on_capability_node_id)
       VALUES ($1, $2, $3, $4)`,
      [ORG, PROJECT_A, A.capabilityNode, A.capabilityNode2],
    );
    await expect(
      owner.query(
        `INSERT INTO capability_node_dependencies (org_id, project_id, capability_node_id, depends_on_capability_node_id)
         VALUES ($1, $2, $3, $4)`,
        [ORG, PROJECT_A, B.capabilityNode, A.capabilityNode2],
      ),
    ).rejects.toThrow(fkError);
    await expect(
      owner.query(
        `INSERT INTO capability_node_dependencies (org_id, project_id, capability_node_id, depends_on_capability_node_id)
         VALUES ($1, $2, $3, $4)`,
        [ORG, PROJECT_A, A.capabilityNode, B.capabilityNode],
      ),
    ).rejects.toThrow(fkError);
  });

  // ---- Edge 5: spec↔capability node (both endpoints) ----
  it("rejects a spec↔capability dependency whose either endpoint is another project", async () => {
    await owner.query(
      `INSERT INTO spec_capability_dependencies (org_id, project_id, spec_id, capability_node_id)
       VALUES ($1, $2, $3, $4)`,
      [ORG, PROJECT_A, A.spec, A.capabilityNode],
    );
    await expect(
      owner.query(
        `INSERT INTO spec_capability_dependencies (org_id, project_id, spec_id, capability_node_id)
         VALUES ($1, $2, $3, $4)`,
        [ORG, PROJECT_A, B.spec, A.capabilityNode],
      ),
    ).rejects.toThrow(fkError);
    await expect(
      owner.query(
        `INSERT INTO spec_capability_dependencies (org_id, project_id, spec_id, capability_node_id)
         VALUES ($1, $2, $3, $4)`,
        [ORG, PROJECT_A, A.spec, B.capabilityNode],
      ),
    ).rejects.toThrow(fkError);
  });

  // ---- Edge 8/9/10: binding generation (reconciliation / snapshot / proof) ----
  it("rejects a binding-generation reference (reconciliation/snapshot/proof) to another project", async () => {
    await expect(
      owner.query(
        `INSERT INTO integration_reconciliations (org_id, id, project_id, requirement_id, binding_id, binding_generation, phase, idempotency_key, request_fingerprint)
         VALUES ($1, 'rec-x', $2, $3, $4, 1, 'discover', 'idem', $5)`,
        [ORG, PROJECT_A, A.requirement, B.binding, D],
      ),
    ).rejects.toThrow(fkError);
    await expect(
      owner.query(
        `INSERT INTO integration_resource_snapshots (org_id, id, project_id, requirement_id, binding_id, binding_generation, provider_kind, external_resource_id, observed_state_hash, sanitized_snapshot, health, last_seen_at)
         VALUES ($1, 'snap-x', $2, $3, $4, 1, 'sentry', 'ext', $5, '{}'::jsonb, 'healthy', now())`,
        [ORG, PROJECT_A, A.requirement, B.binding, D],
      ),
    ).rejects.toThrow(fkError);
  });

  // ---- Edge 17: delivery run↔authority decision ----
  it("rejects a delivery run citing another project's authority decision", async () => {
    await expect(
      owner.query(
        `INSERT INTO delivery_runs (org_id, id, project_id, authority_decision_id, merge_sha)
         VALUES ($1, 'run-x', $2, $3, $4)`,
        [ORG, PROJECT_A, B.authorityDecision, D],
      ),
    ).rejects.toThrow(fkError);
  });

  // ---- Edge 19: delivery-run binding↔run + binding generation (composite) ----
  it("rejects a delivery-run binding whose binding generation is another project", async () => {
    await owner.query(
      `INSERT INTO delivery_run_bindings (org_id, project_id, delivery_run_id, binding_id, binding_generation)
       VALUES ($1, $2, $3, $4, 1)`,
      [ORG, PROJECT_A, A.deliveryRun, A.binding],
    );
    await expect(
      owner.query(
        `INSERT INTO delivery_run_bindings (org_id, project_id, delivery_run_id, binding_id, binding_generation)
         VALUES ($1, $2, $3, $4, 1)`,
        [ORG, PROJECT_A, A.deliveryRun, B.binding],
      ),
    ).rejects.toThrow(fkError);
  });

  // ---- Edge 20: binding output (integration_binding_env) ----
  it("rejects a binding-env output row whose binding generation is another project", async () => {
    await expect(
      owner.query(
        `INSERT INTO integration_binding_env (org_id, project_id, binding_id, binding_generation, key, classification)
         VALUES ($1, $2, $3, 1, 'k', 'non_secret')`,
        [ORG, PROJECT_A, B.binding],
      ),
    ).rejects.toThrow(fkError);
  });

  // ---- Edge 21: project app env↔binding output (five-column common-project FK) ----
  it("rejects a provisioned app-env row citing another project's binding output", async () => {
    await owner.query(
      `INSERT INTO project_app_env (org_id, id, project_id, environment, key, source, value_ref, binding_id, binding_generation, secret_generation)
       VALUES ($1, 'env-ctrl', $2, 'production', $3, 'provisioned', 'secret://x', $4, 1, 1)`,
      [ORG, PROJECT_A, A.envKey, A.binding],
    );
    await expect(
      owner.query(
        `INSERT INTO project_app_env (org_id, id, project_id, environment, key, source, value_ref, binding_id, binding_generation, secret_generation)
         VALUES ($1, 'env-x', $2, 'production', 'k2', 'provisioned', 'secret://y', $3, 1, 1)`,
        [ORG, PROJECT_A, B.binding],
      ),
    ).rejects.toThrow(fkError);
  });

  // ---- Edges 11-16: validation proof spec / revision / verdict / unit / binding gen ----
  it("rejects validation-proof endpoints drawn from another project (spec/revision/verdict/unit/gen)", async () => {
    const baseProof = (overrides: Record<string, string>) => ({
      org: ORG,
      project: PROJECT_A,
      id: `proof-${Math.random().toString(36).slice(2)}`,
      spec: A.spec,
      revision: A.behaviorRevision,
      verdict: A.verdict,
      unit: A.proofUnit,
      requirement: A.requirement,
      binding: A.binding,
      deliveryRun: A.deliveryRun,
      deployment: "dep",
      ...overrides,
    });
    const insertProof = (p: ReturnType<typeof baseProof>) =>
      owner.query(
        `INSERT INTO integration_validation_proofs
           (org_id, id, project_id, spec_id, behavior_revision_id, behavior_verdict_id, proof_unit_digest,
            requirement_id, binding_id, binding_generation, delivery_run_id, deployment_id, deploy_sha,
            probe_version, correlation_id, trigger_digest, sanitized_observation, provider_receipt_id,
            provider_receipt_at, verdict, evidence_digest, signature, fresh_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,'pv',$12,$12,'{}'::jsonb,'rcpt',now(),'passed',$13,$12,now())`,
        [
          p.org,
          p.id,
          p.project,
          p.spec,
          p.revision,
          p.verdict,
          p.unit,
          p.requirement,
          p.binding,
          p.deliveryRun,
          p.deployment,
          D,
          CAS_A,
        ],
      );
    // control (all Project A) succeeds.
    await insertProof(baseProof({}));
    await expect(insertProof(baseProof({ spec: B.spec }))).rejects.toThrow(fkError);
    await expect(insertProof(baseProof({ revision: B.behaviorRevision }))).rejects.toThrow(fkError);
    await expect(insertProof(baseProof({ verdict: B.verdict }))).rejects.toThrow(fkError);
    await expect(insertProof(baseProof({ unit: B.proofUnit }))).rejects.toThrow(fkError);
    await expect(insertProof(baseProof({ binding: B.binding }))).rejects.toThrow(fkError);
  });
});
