// cspell:ignore cicompat
// rv-20 real-Postgres proof for the behavior-attempt CI compatibility projection.
// Production `recordAttemptedVerdict` writes plan + attempt + projection + verdict in one
// org-scoped transaction. The compatibility table remains a reader projection only.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import { ingestJunitResults } from "../src/engine/ci/junitIngest.js";
import { loadCiTestObservations } from "../src/engine/insights/ciFlaky.js";
import {
  CiCompatibilityProjectionConflictError,
  PgAcceptanceRunStore,
  writeCiCompatibilityProjection,
  type EnsureVerificationPlanInput,
  type RecordAcceptanceVerdictInput,
  type RecordAttemptInput,
} from "../src/engine/verification/acceptance/index.js";
import { PgAcceptanceCompletenessChecker } from "../src/engine/verification/acceptance/completenessInvariant.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_rv20_cicompat";
const OTHER_ORG = "org_rv20_cicompat_other";
const PROJECT = "project_rv20_cicompat";
const SPEC = "spec_rv20_cicompat";
const WORKFLOW_RUN = "run_rv20_cicompat";
const POST_RUN = "behavior_run_rv20_post";
const MANUAL_RUN = "behavior_run_rv20_manual";
const PRE_MERGE_RUN = "behavior_run_rv20_pre_merge";
const POST_ATTEMPT = "behavior_attempt_rv20_post";
const MANUAL_ATTEMPT = "behavior_attempt_rv20_manual";
const ENVIRONMENT = "environment_rv20_cicompat";
const RELEASE = "release_rv20_cicompat";
const BEHAVIOR = "behavior_revision_rv20_cicompat";
const PERSONA = "persona_revision_rv20_cicompat";
const HEAD = "abc123-rv20-head";
const HASH = `sha256:${"c".repeat(64)}`;
const ARTIFACT = `sha256:${"a".repeat(64)}`;
const PLAN_HASH = `sha256:${"d".repeat(64)}`;

function databaseName(): string {
  return `tanren_rv20_cicompat_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function connectionUrl(database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(ADMIN_URL);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

async function seedBase(owner: Pool): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [org],
    );
  }
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.invalid/rv20.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 'rv20', 'CI compatibility projection', 'in_flight')`,
    [SPEC, PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'mission/rv20', 'running')`,
    [WORKFLOW_RUN, SPEC, PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/mission/rv20', 'merge_batch', 'member-rv20')`,
    [WORKFLOW_RUN, PROJECT, ORG, HASH],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, ARTIFACT, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions
       (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona-rv20', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA, ORG, PROJECT, HASH],
  );
  await owner.query(
    `INSERT INTO behavior_revisions
       (id, org_id, project_id, behavior_id, persona_revision_id, revision_number,
        title, given, "when", "then", content_digest)
     VALUES ($1, $2, $3, 'behavior-rv20', $4, 1, 'behavior', 'given', 'when', 'then', $5)`,
    [BEHAVIOR, ORG, PROJECT, PERSONA, HASH],
  );
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG, ENVIRONMENT, PROJECT, WORKFLOW_RUN, ARTIFACT, HASH],
  );
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref,
        artifact_digest, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'fixture', 'rv20', 'production', 'deploy-rv20', 'main',
             $4, $5, 'https://example.invalid/rv20', 'live')`,
    [ORG, RELEASE, PROJECT, ARTIFACT, WORKFLOW_RUN],
  );
  await owner.query(
    `INSERT INTO release_instance_behavior_revisions
       (org_id, release_instance_id, behavior_revision_id, ordinal)
     VALUES ($1, $2, $3, 0)`,
    [ORG, RELEASE, BEHAVIOR],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs
       (org_id, id, project_id, purpose, run_id, spec_id, integration_node_id, environment_id,
        prepared_head_sha, jj_tree_id, plan_set_hash, runtime_behavior_context_hash,
        artifact_digest, status, policy)
     VALUES ($1, $2, $3, 'pre_merge', $4, $5, $4, $6, $7, $8, $8, $8, $9, 'completed', '{}'::jsonb)`,
    [ORG, PRE_MERGE_RUN, PROJECT, WORKFLOW_RUN, SPEC, ENVIRONMENT, HEAD, HASH, ARTIFACT],
  );
}

function plan(runId: string): EnsureVerificationPlanInput {
  return {
    orgId: ORG,
    projectId: PROJECT,
    planId: `plan:${runId}`,
    behaviorRevisionId: BEHAVIOR,
    planHash: PLAN_HASH,
    planJson: { runId },
  };
}

function attempt(runId: string, outcome: RecordAttemptInput["outcome"]): RecordAttemptInput {
  return {
    orgId: ORG,
    projectId: PROJECT,
    runId,
    behaviorRevisionId: BEHAVIOR,
    planId: `plan:${runId}`,
    exampleHash: `example:${runId}`,
    matrixHash: `matrix:${runId}`,
    shard: 0,
    seed: `seed:${runId}`,
    outcome,
    classification: outcome === "passed" ? "product_resolved" : "inconclusive",
    startedAt: "2026-07-22T12:00:00.000Z",
    finishedAt: "2026-07-22T12:00:01.250Z",
  };
}

function verdict(
  runId: string,
  outcome: RecordAttemptInput["outcome"],
): Omit<RecordAcceptanceVerdictInput, "attemptTrace"> {
  const passed = outcome === "passed";
  return {
    orgId: ORG,
    projectId: PROJECT,
    runId,
    behaviorRevisionId: BEHAVIOR,
    exampleHash: `example:${runId}`,
    matrixHash: `matrix:${runId}`,
    requiredAssertionCount: passed ? 1 : 0,
    executedAssertionCount: passed ? 1 : 0,
    outcome,
    attemptCount: 1,
    flakeState: "stable",
    gateEffect: "blocking",
    artifactDigest: parseDigest(ARTIFACT),
    runtimeBehaviorContextHash: parseDigest(HASH),
    assertionEvidence: passed ? [{ assertionId: "assertion-rv20", executed: true, passed: true }] : [],
    attemptEvidence: [{ attemptOrdinal: 1, outcome }],
  };
}

async function seedProof(owner: Pool): Promise<void> {
  await owner.query(
    `INSERT INTO proof_bundles
       (org_id, id, project_id, bundle_digest, proof_root, bytes_digest, integration_node_id,
        member_set_hash, prepared_head_sha, jj_tree_id, artifact_digest, expected_main_sha,
        signing_key_id, root_signature, nonce, issued_at, expires_at)
     VALUES ($1, 'proof-bundle-rv20', $2, $3, $3, $4, $5, $3, $6, $3, $4, $6,
             'key-rv20', $7, 'nonce-rv20', now(), now() + interval '1 day')`,
    [ORG, PROJECT, HASH, ARTIFACT, WORKFLOW_RUN, HEAD, Buffer.from([1])],
  );
  await owner.query(
    `INSERT INTO gate_proof_bundles
       (org_id, project_id, id, integration_node_id, gate_config_hash, policy_version,
        quarantine_version, proof_bundle_id, gate_verdict)
     VALUES ($1, $2, 'gate-proof-rv20', $3, $4, 'v1', 'v1', 'proof-bundle-rv20', 'passed')`,
    [ORG, PROJECT, WORKFLOW_RUN, HASH],
  );
}

describeDb("rv-20 behavior-attempt CI compatibility projection — real Postgres", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let store: PgAcceptanceRunStore;
  const postInput = attempt(POST_RUN, "passed");
  const manualInput = attempt(MANUAL_RUN, "inconclusive_external");

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedBase(owner);
    const runIds = [POST_RUN, MANUAL_RUN];
    const attemptIds = [POST_ATTEMPT, MANUAL_ATTEMPT];
    const verdictIds = ["verdict-rv20-post", "verdict-rv20-manual"];
    store = new PgAcceptanceRunStore(app, {
      runId: () => runIds.shift() ?? "unexpected-run-id",
      attemptId: () => attemptIds.shift() ?? "unexpected-attempt-id",
      verdictId: () => verdictIds.shift() ?? "unexpected-verdict-id",
    });
    await store.recordRun({
      orgId: ORG,
      projectId: PROJECT,
      purpose: "post_merge_production",
      runId: WORKFLOW_RUN,
      specId: SPEC,
      integrationNodeId: WORKFLOW_RUN,
      environmentId: ENVIRONMENT,
      preparedHeadSha: HEAD,
      jjTreeId: HASH,
      planSetHash: parseDigest(HASH),
      runtimeBehaviorContextHash: parseDigest(HASH),
      artifactDigest: parseDigest(ARTIFACT),
    });
    await store.recordRun({
      orgId: ORG,
      projectId: PROJECT,
      purpose: "manual_canary",
      environmentId: ENVIRONMENT,
      preparedHeadSha: HEAD,
      jjTreeId: HASH,
      planSetHash: parseDigest(HASH),
      runtimeBehaviorContextHash: parseDigest(HASH),
      artifactDigest: parseDigest(ARTIFACT),
    });
    await store.recordAttemptedVerdict({
      plan: plan(POST_RUN),
      attempt: postInput,
      verdict: verdict(POST_RUN, "passed"),
    });
    await store.recordAttemptedVerdict({
      plan: plan(MANUAL_RUN),
      attempt: manualInput,
      verdict: verdict(MANUAL_RUN, "inconclusive_external"),
    });
    await store.completeRun({ orgId: ORG, runId: POST_RUN, status: "completed" });
    await store.completeRun({ orgId: ORG, runId: MANUAL_RUN, status: "completed" });
    await seedProof(owner);
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("projects run-bound and manual-canary attempts with exact immutable compatibility facts", async () => {
    const rows = await runWithOrgScope(app, ORG, (client) =>
      client.query(
        `SELECT test_id, suite, head_sha, run_id, source_kind, behavior_verification_run_id,
                behavior_attempt_id, outcome, duration_ms
           FROM ci_test_results
          WHERE source_kind = 'behavior_verification'
          ORDER BY behavior_attempt_id`,
      ),
    );
    expect(rows.rows).toEqual([
      {
        test_id: `behavior:${BEHAVIOR}:example:${MANUAL_RUN}:matrix:${MANUAL_RUN}`,
        suite: "runtime-behavior",
        head_sha: HEAD,
        run_id: null,
        source_kind: "behavior_verification",
        behavior_verification_run_id: MANUAL_RUN,
        behavior_attempt_id: MANUAL_ATTEMPT,
        outcome: "error",
        duration_ms: 1250,
      },
      {
        test_id: `behavior:${BEHAVIOR}:example:${POST_RUN}:matrix:${POST_RUN}`,
        suite: "runtime-behavior",
        head_sha: HEAD,
        run_id: WORKFLOW_RUN,
        source_kind: "behavior_verification",
        behavior_verification_run_id: POST_RUN,
        behavior_attempt_id: POST_ATTEMPT,
        outcome: "passed",
        duration_ms: 1250,
      },
    ]);
    await runWithOrgScope(app, ORG, (client) => writeCiCompatibilityProjection(client, POST_ATTEMPT, postInput));
    const count = await runWithOrgScope(app, ORG, (client) =>
      client.query("SELECT COUNT(*)::int AS n FROM ci_test_results WHERE behavior_attempt_id = $1", [POST_ATTEMPT]),
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("keeps native JUnit ingestion unchanged and exposes projected history to the CI-flake reader", async () => {
    await runWithOrgScope(app, ORG, (client) =>
      ingestJunitResults({
        client,
        eventStore: { append: () => Promise.resolve() },
        run: { orgId: ORG, projectId: PROJECT, runId: WORKFLOW_RUN },
        report: {
          total: 1,
          failures: 0,
          results: [
            {
              testId: "native.junit.case",
              file: "native.test.ts",
              suite: "native",
              outcome: "passed",
              durationMs: 25,
              retries: 0,
              flakyFailure: false,
            },
          ],
        },
        headSha: HEAD,
        attempt: 1,
        testExitCode: 0,
      }),
    );
    const native = await runWithOrgScope(app, ORG, (client) =>
      client.query(
        `SELECT source_kind, behavior_verification_run_id, behavior_attempt_id
           FROM ci_test_results WHERE test_id = 'native.junit.case'`,
      ),
    );
    expect(native.rows).toEqual([
      { source_kind: "native_ci", behavior_verification_run_id: null, behavior_attempt_id: null },
    ]);
    const observations = await runWithOrgScope(app, ORG, (client) =>
      loadCiTestObservations(client, { projectId: PROJECT, since: new Date("2026-01-01T00:00:00.000Z") }),
    );
    expect(observations.map((row) => row.testId)).toEqual(
      expect.arrayContaining(["native.junit.case", `behavior:${BEHAVIOR}:example:${POST_RUN}:matrix:${POST_RUN}`]),
    );
  });

  it("passes completeness only alongside first-class plan, verdict, and proof facts", async () => {
    await expect(
      new PgAcceptanceCompletenessChecker(app).check({
        orgId: ORG,
        projectId: PROJECT,
        releaseInstanceId: RELEASE,
        promotedArtifactDigest: ARTIFACT,
      }),
    ).resolves.toEqual({ complete: true, kind: "complete", runId: POST_RUN, requiredBehaviorRevisionCount: 1 });
  });

  it("REQUIRED NEGATIVE CONTROL — deleted compat row -> ci_compat_projection_missing; foreign-org row rejected by RLS/FK; idempotency conflict fails loud", async () => {
    await runWithOrgScope(app, ORG, (client) =>
      client.query("DELETE FROM ci_test_results WHERE org_id = $1 AND behavior_attempt_id = $2", [ORG, POST_ATTEMPT]),
    );
    await expect(
      new PgAcceptanceCompletenessChecker(app).check({
        orgId: ORG,
        projectId: PROJECT,
        releaseInstanceId: RELEASE,
        promotedArtifactDigest: ARTIFACT,
      }),
    ).resolves.toEqual({ complete: false, failure: "ci_compat_projection_missing" });
    await runWithOrgScope(app, ORG, (client) => writeCiCompatibilityProjection(client, POST_ATTEMPT, postInput));

    const crossOrgInsert = `INSERT INTO ci_test_results
       (id, project_id, org_id, test_id, suite, head_sha, source_kind,
        behavior_verification_run_id, behavior_attempt_id, outcome)
     VALUES ('foreign-rv20', $1, $2, 'foreign', 'runtime-behavior', $3,
             'behavior_verification', $4, $5, 'passed')`;
    await expect(
      runWithOrgScope(app, ORG, (client) =>
        client.query(crossOrgInsert, [PROJECT, OTHER_ORG, HEAD, POST_RUN, POST_ATTEMPT]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(owner.query(crossOrgInsert, [PROJECT, OTHER_ORG, HEAD, POST_RUN, POST_ATTEMPT])).rejects.toMatchObject(
      {
        code: "23503",
      },
    );

    await expect(
      runWithOrgScope(app, ORG, (client) =>
        writeCiCompatibilityProjection(client, POST_ATTEMPT, { ...postInput, outcome: "failed_visual" }),
      ),
    ).rejects.toBeInstanceOf(CiCompatibilityProjectionConflictError);
    const immutable = await runWithOrgScope(app, ORG, (client) =>
      client.query("SELECT outcome FROM ci_test_results WHERE behavior_attempt_id = $1", [POST_ATTEMPT]),
    );
    expect(immutable.rows).toEqual([{ outcome: "passed" }]);
  });
});
