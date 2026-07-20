// cspell:ignore venv vcap
// rv-10 runs/attempts/verdicts lifecycle — real-Postgres proof. Gated on TANREN_RLS_DB_TEST;
// every decisive write runs as the non-superuser tanren_app role. It proves a live run records
// a RUN + real ATTEMPT (behavior_verification_attempts) + per-behavior VERDICT, all FK-linked
// (verdict traceable to attempt to run); that a captured artifact carries the producing attempt
// (producing_attempt_id, no longer NULL); and that the lifecycle FAILS CLOSED on an orphan
// verdict, a borrowed attempt, an attempt-count mismatch, an attemptless-over-a-run-that-attempted
// verdict, and an orphan capture. FINDING 1: traceability is MANDATORY (attemptTrace discriminated
// union, no skip path). FINDING 2: recordAttemptedVerdict records the attempt + verdict ATOMICALLY,
// so a forced traceability failure leaves ZERO residual attempt AND verdict rows (re-SELECTed).
// FINDING 3: a dedupe conflict backfills a NULL producing_attempt_id. Cross-org readers see ZERO.
import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentDigestOf, parseDigest, type Digest } from "../src/engine/contracts/cas.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import {
  AttemptlessVerdictHasAttemptsError,
  OrphanVerdictError,
  PgAcceptanceRunStore,
  PgVerificationCaptureStore,
  VerdictAttemptCountMismatchError,
  VerdictAttemptTraceabilityError,
  type EnsureVerificationPlanInput,
  type RecordAcceptanceVerdictInput,
  type RecordAttemptInput,
  type VerdictAttemptTrace,
} from "../src/engine/verification/acceptance/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

const ORG = "org_rv10_lifecycle";
const OTHER_ORG = "org_rv10_lifecycle_other";
const PROJECT = "project_rv10_lifecycle";
const D = `sha256:${"c".repeat(64)}`;
const CAS = `sha256:${"a".repeat(64)}`;
const PLAN_HASH = `sha256:${"d".repeat(64)}`;
const RUN_ID = "rv10_lifecycle_run";
const ENV_ID = "venv_rv10_lifecycle";
const NODE_ID = "inode_rv10_lifecycle";
const BEHAVIOR_REVISION = "br_rv10_lifecycle";
const PERSONA_REVISION = "pr_rv10_lifecycle";
const PLAN_ID = "plan_rv10_lifecycle";
const EXAMPLE_HASH = "example_rv10_lifecycle";
const MATRIX_HASH = "matrix_rv10_lifecycle";

function databaseName(): string {
  return `tanren_rv10_lifecycle_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedTenant(owner: Pool): Promise<void> {
  for (const org of [ORG, OTHER_ORG]) {
    await owner.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [org],
    );
  }
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO integration_nodes (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, member_key)
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-rv10')`,
    [NODE_ID, PROJECT, ORG, D],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 0, 'application/octet-stream', 'inline_pg', $3)`,
    [ORG, CAS, Buffer.from([0])],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA_REVISION, ORG, PROJECT, D],
  );
  await owner.query(
    `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest)
     VALUES ($1, $2, $3, 'behavior', $4, 1, 'behavior', 'g', 'w', 't', $5)`,
    [BEHAVIOR_REVISION, ORG, PROJECT, PERSONA_REVISION, D],
  );
  await owner.query(
    `INSERT INTO verification_environments (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target, environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'container', $6, $6, 'ready')`,
    [ORG, ENV_ID, PROJECT, NODE_ID, CAS, D],
  );
  await owner.query(
    `INSERT INTO behavior_verification_runs (org_id, id, project_id, purpose, environment_id, prepared_head_sha, jj_tree_id, plan_set_hash, runtime_behavior_context_hash, artifact_digest, status, policy)
     VALUES ($1, $2, $3, 'manual_canary', $4, $5, $5, $5, $5, $6, 'running', '{}'::jsonb)`,
    [ORG, RUN_ID, PROJECT, ENV_ID, D, CAS],
  );
}

function planInput(overrides: Partial<EnsureVerificationPlanInput> = {}): EnsureVerificationPlanInput {
  return {
    orgId: ORG,
    projectId: PROJECT,
    planId: PLAN_ID,
    behaviorRevisionId: BEHAVIOR_REVISION,
    planHash: PLAN_HASH,
    planJson: { planId: PLAN_ID },
    ...overrides,
  };
}

function attemptInput(overrides: Partial<RecordAttemptInput> = {}): RecordAttemptInput {
  return {
    orgId: ORG,
    projectId: PROJECT,
    runId: RUN_ID,
    behaviorRevisionId: BEHAVIOR_REVISION,
    planId: PLAN_ID,
    exampleHash: EXAMPLE_HASH,
    matrixHash: MATRIX_HASH,
    shard: 0,
    seed: "seed-rv10",
    outcome: "passed",
    classification: "product_resolved",
    startedAt: "2026-07-19T00:00:00.000Z",
    finishedAt: "2026-07-19T00:00:01.000Z",
    ...overrides,
  };
}

function verdictCore(
  overrides: Partial<Omit<RecordAcceptanceVerdictInput, "attemptTrace">> = {},
): Omit<RecordAcceptanceVerdictInput, "attemptTrace"> {
  return {
    orgId: ORG,
    projectId: PROJECT,
    runId: RUN_ID,
    behaviorRevisionId: BEHAVIOR_REVISION,
    exampleHash: EXAMPLE_HASH,
    matrixHash: MATRIX_HASH,
    requiredAssertionCount: 1,
    executedAssertionCount: 1,
    outcome: "passed",
    attemptCount: 1,
    flakeState: "stable",
    gateEffect: "blocking",
    artifactDigest: parseDigest(CAS),
    runtimeBehaviorContextHash: parseDigest(D),
    assertionEvidence: [{ assertionId: "a1", executed: true, passed: true }],
    attemptEvidence: [{ attemptOrdinal: 1, outcome: "passed" }],
    ...overrides,
  };
}

function verdictInput(
  trace: VerdictAttemptTrace,
  overrides: Partial<Omit<RecordAcceptanceVerdictInput, "attemptTrace">> = {},
): RecordAcceptanceVerdictInput {
  return { ...verdictCore(overrides), attemptTrace: trace };
}

describeDb("rv-10 runs/attempts/verdicts lifecycle — real Postgres", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let store: PgAcceptanceRunStore;
  let captures: PgVerificationCaptureStore;
  const captureBytes = new TextEncoder().encode(JSON.stringify({ probe: "p1", status: 200 }));
  const captureDigest: Digest = contentDigestOf(captureBytes);
  let attemptId: string;
  let capturedArtifactId: string;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner);
    store = new PgAcceptanceRunStore(app);
    captures = new PgVerificationCaptureStore(app, new PgCasByteStore(app));
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

  it("records the plan + real attempt referents (attempt.plan_id / run FKs resolve)", async () => {
    const ensured = await store.ensureVerificationPlan(planInput());
    expect(ensured).toBe(PLAN_ID);
    attemptId = await store.recordAttempt(attemptInput());
    expect(attemptId).toMatch(/^verification_attempt_/u);
    const row = await runWithOrgScope(app, ORG, (client) =>
      client.query(
        "SELECT run_id, plan_id, outcome FROM behavior_verification_attempts WHERE org_id = $1 AND id = $2",
        [ORG, attemptId],
      ),
    );
    expect(row.rows[0]).toEqual({ run_id: RUN_ID, plan_id: PLAN_ID, outcome: "passed" });
  });

  it("stamps the captured artifact with the producing attempt (producing_attempt_id, no longer NULL)", async () => {
    const captured = await captures.capture({
      orgId: ORG,
      projectId: PROJECT,
      kind: "response_capture",
      mediaType: "application/json",
      bytes: captureBytes,
      redactionClass: "sensitive",
      producingAttemptId: attemptId,
    });
    expect(captured.casDigest).toBe(captureDigest);
    capturedArtifactId = captured.verificationArtifactId;
    const row = await runWithOrgScope(app, ORG, (client) =>
      client.query("SELECT producing_attempt_id FROM verification_artifacts WHERE org_id = $1 AND id = $2", [
        ORG,
        capturedArtifactId,
      ]),
    );
    expect(row.rows[0]?.producing_attempt_id).toBe(attemptId);
  });

  it("FAIL-CLOSED: a capture naming a non-existent attempt is rejected (no orphan producing link)", async () => {
    await expect(
      captures.capture({
        orgId: ORG,
        projectId: PROJECT,
        kind: "render_dom",
        mediaType: "text/html",
        bytes: new TextEncoder().encode("<html></html>"),
        redactionClass: "sensitive",
        producingAttemptId: "verification_attempt_missing",
      }),
    ).rejects.toThrow(/verification_artifacts_attempt_fk|foreign key/iu);
  });

  it("FINDING 3: a dedupe conflict backfills a NULL producing_attempt_id (never overwrites)", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ dedupe: "finding3" }));
    // First a STANDALONE capture with no attempt context — producing_attempt_id lands NULL.
    const first = await captures.capture({
      orgId: ORG,
      projectId: PROJECT,
      kind: "response_capture",
      mediaType: "application/json",
      bytes,
      redactionClass: "sensitive",
    });
    expect(first.deduped).toBe(false);
    const beforeRow = await runWithOrgScope(app, ORG, (client) =>
      client.query("SELECT producing_attempt_id FROM verification_artifacts WHERE org_id = $1 AND id = $2", [
        ORG,
        first.verificationArtifactId,
      ]),
    );
    expect(beforeRow.rows[0]?.producing_attempt_id).toBeNull();
    // The production path captures the SAME (project, digest, kind) WITH the real attempt: the
    // dedupe conflict now BACKFILLS the previously-NULL producing_attempt_id.
    const second = await captures.capture({
      orgId: ORG,
      projectId: PROJECT,
      kind: "response_capture",
      mediaType: "application/json",
      bytes,
      redactionClass: "sensitive",
      producingAttemptId: attemptId,
    });
    expect(second.deduped).toBe(true);
    expect(second.verificationArtifactId).toBe(first.verificationArtifactId);
    const afterRow = await runWithOrgScope(app, ORG, (client) =>
      client.query("SELECT producing_attempt_id FROM verification_artifacts WHERE org_id = $1 AND id = $2", [
        ORG,
        first.verificationArtifactId,
      ]),
    );
    expect(afterRow.rows[0]?.producing_attempt_id).toBe(attemptId);
  });

  it("seals the verdict bound to its producing attempt — verdict → attempt → run is traceable", async () => {
    const verdictId = await store.recordVerdict(
      verdictInput(
        { kind: "attempted", producingAttemptId: attemptId },
        {
          evidenceLinks: [
            {
              verificationArtifactId: capturedArtifactId as never,
              casDigest: captureDigest,
              mediaType: "application/json",
            },
          ],
        },
      ),
    );
    expect(verdictId).toMatch(/^verdict_/u);
    // Traceability: the verdict's natural key resolves to exactly the recorded attempt, whose
    // run_id FK resolves to the seeded run — a complete verdict → attempt → run chain.
    const chain = await runWithOrgScope(app, ORG, (client) =>
      client.query(
        `SELECT a.id AS attempt_id, a.run_id, r.status AS run_status
           FROM behavior_verdicts v
           JOIN behavior_verification_attempts a
             ON a.org_id = v.org_id AND a.run_id = v.run_id AND a.behavior_revision_id = v.behavior_revision_id
            AND a.example_hash = v.example_hash AND a.matrix_hash = v.matrix_hash
           JOIN behavior_verification_runs r ON r.org_id = a.org_id AND r.id = a.run_id
          WHERE v.org_id = $1 AND v.id = $2`,
        [ORG, verdictId],
      ),
    );
    expect(chain.rows).toEqual([{ attempt_id: attemptId, run_id: RUN_ID, run_status: "running" }]);
  });

  it("FAIL-CLOSED: an orphan verdict (attempted names an attempt that does not exist) never seals", async () => {
    await expect(
      store.recordVerdict(verdictInput({ kind: "attempted", producingAttemptId: "verification_attempt_missing" })),
    ).rejects.toBeInstanceOf(OrphanVerdictError);
  });

  it("FAIL-CLOSED: a borrowed attempt (key mismatch) is not traceable and never seals", async () => {
    await expect(
      store.recordVerdict(
        verdictInput({ kind: "attempted", producingAttemptId: attemptId }, { exampleHash: "a-different-example" }),
      ),
    ).rejects.toBeInstanceOf(VerdictAttemptTraceabilityError);
  });

  it("FAIL-CLOSED: attempt_count that disagrees with the real attempt rows never seals", async () => {
    await expect(
      store.recordVerdict(
        verdictInput(
          { kind: "attempted", producingAttemptId: attemptId },
          {
            attemptCount: 2,
            attemptEvidence: [
              { attemptOrdinal: 1, outcome: "failed_product" },
              { attemptOrdinal: 2, outcome: "passed" },
            ],
          },
        ),
      ),
    ).rejects.toBeInstanceOf(VerdictAttemptCountMismatchError);
  });

  it("attemptless: a verdict for a natural key with ZERO attempts seals (justified escape hatch)", async () => {
    const verdictId = await store.recordVerdict(
      verdictInput(
        { kind: "attemptless" },
        {
          exampleHash: "attemptless_example",
          matrixHash: "attemptless_matrix",
          outcome: "inconclusive_external",
          requiredAssertionCount: 0,
          executedAssertionCount: 0,
          attemptCount: 0,
          assertionEvidence: [],
          attemptEvidence: [],
        },
      ),
    );
    expect(verdictId).toMatch(/^verdict_/u);
  });

  it("FAIL-CLOSED: an attemptless verdict over a run that DID attempt the behavior never seals", async () => {
    await expect(store.recordVerdict(verdictInput({ kind: "attemptless" }))).rejects.toBeInstanceOf(
      AttemptlessVerdictHasAttemptsError,
    );
  });

  it("FINDING 2: recordAttemptedVerdict records the attempt + verdict ATOMICALLY", async () => {
    const result = await store.recordAttemptedVerdict({
      plan: planInput(),
      attempt: attemptInput({ exampleHash: "atomic_example", matrixHash: "atomic_matrix" }),
      verdict: verdictCore({ exampleHash: "atomic_example", matrixHash: "atomic_matrix" }),
    });
    expect(result.attemptId).toMatch(/^verification_attempt_/u);
    expect(result.verdictId).toMatch(/^verdict_/u);
    const rows = await runWithOrgScope(app, ORG, async (client) => {
      const a = await client.query("SELECT id FROM behavior_verification_attempts WHERE org_id = $1 AND id = $2", [
        ORG,
        result.attemptId,
      ]);
      const v = await client.query("SELECT id FROM behavior_verdicts WHERE org_id = $1 AND id = $2", [
        ORG,
        result.verdictId,
      ]);
      return { attempts: a.rowCount ?? 0, verdicts: v.rowCount ?? 0 };
    });
    expect(rows).toEqual({ attempts: 1, verdicts: 1 });
  });

  it("FINDING 2: a forced traceability failure rolls BOTH back — ZERO residual attempt AND verdict rows", async () => {
    const KEY = "rollback_example";
    // attempt_count=2 while recordAttemptedVerdict materializes exactly ONE attempt → the in-txn
    // traceability assertion throws, rolling the attempt back with the verdict.
    await expect(
      store.recordAttemptedVerdict({
        plan: planInput(),
        attempt: attemptInput({ exampleHash: KEY, matrixHash: KEY }),
        verdict: verdictCore({
          exampleHash: KEY,
          matrixHash: KEY,
          attemptCount: 2,
          attemptEvidence: [
            { attemptOrdinal: 1, outcome: "failed_product" },
            { attemptOrdinal: 2, outcome: "passed" },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(VerdictAttemptCountMismatchError);
    // The proof the audit demanded: RE-SELECT both tables for the forced key → nothing survives.
    const residual = await runWithOrgScope(app, ORG, async (client) => {
      const a = await client.query(
        "SELECT id FROM behavior_verification_attempts WHERE org_id = $1 AND example_hash = $2",
        [ORG, KEY],
      );
      const v = await client.query("SELECT id FROM behavior_verdicts WHERE org_id = $1 AND example_hash = $2", [
        ORG,
        KEY,
      ]);
      return { attempts: a.rowCount ?? 0, verdicts: v.rowCount ?? 0 };
    });
    expect(residual).toEqual({ attempts: 0, verdicts: 0 });
  });

  it("CROSS-ORG ZERO: another org sees zero attempt rows for this run", async () => {
    const foreign = await runWithOrgScope(app, OTHER_ORG, (client) =>
      client.query("SELECT id FROM behavior_verification_attempts WHERE run_id = $1", [RUN_ID]),
    );
    expect(foreign.rowCount ?? 0).toBe(0);
    const own = await runWithOrgScope(app, ORG, (client) =>
      client.query("SELECT id FROM behavior_verification_attempts WHERE run_id = $1", [RUN_ID]),
    );
    expect((own.rowCount ?? 0) >= 1).toBe(true);
  });
});
