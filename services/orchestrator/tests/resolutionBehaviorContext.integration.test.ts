// cspell:ignore bytea iloop venv vrun
// bh-15 real-Postgres proof (restricted tanren_app role) that the locked
// behavior-context loader binds the EXACT behavior revision the release froze —
// never the latest lineage head — and that baseline + production store one
// identical context digest in the verification-run facts. The negative control
// proves an empty/unresolvable bound set fails CLOSED: the walker settles the
// job stale_contract WITHOUT running the probe, the ResolutionAuthority, or the
// source-close outbox, and never substitutes the (newer) active head.
//
// Gated on TANREN_RLS_DB_TEST (like every peer *.integration.test with real PG).
/* eslint-disable unicorn/no-thenable */
// `then` here is the immutable BDD Given/When/Then field on behavior revisions,
// asserted and seeded verbatim — never a thenable.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SymptomContractV1 } from "../src/engine/contracts/symptomContract.js";
import type { ResolutionJob } from "../src/engine/contracts/resolutionStage.js";
import type { ResolutionAuthority } from "../src/engine/contracts/resolutionAuthority.js";
import { ResolutionJobStore } from "../src/engine/repositories/resolutionJobs.js";
import { SymptomContractStore } from "../src/engine/repositories/symptomContracts.js";
import { PgBehaviorRevisionStore } from "../src/engine/repositories/behaviorRevisionStore.js";
import { parsePersonaRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import { ResolutionDagWalker } from "../src/engine/dag/resolutionDagWalker.js";
import {
  BaselineReproductionStage,
  createResolutionStageRegistry,
  LockedBehaviorContextError,
  PgRuntimeBehaviorContextLoader,
  ProductionSymptomStage,
  type RuntimeBehaviorContextLoader,
} from "../src/engine/verification/resolutionStages/index.js";

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_bh15_locked_ctx";
const PROJECT = "project_bh15_locked_ctx";
const LOOP = "iloop_bh15_locked_ctx";
const SOURCE = "source_bh15_locked_ctx";
const NODE = "inode_bh15_locked_ctx";
const ENV = "venv_bh15_locked_ctx";
const RELEASE = "release_bh15_locked_ctx";
const PERSONA = "persona_revision_bh15_locked_ctx";
const BEHAVIOR_ID = "behavior_bh15_locked_ctx";
const BOUND_REVISION = "behavior_revision_bh15_bound";
const CONTRACT_SOURCE_REVISION = "bh15-source-revision";
const ORIGINAL_GIVEN = "Given the ORIGINAL frozen precondition";
const ORIGINAL_WHEN = "When the ORIGINAL action runs";
const ORIGINAL_THEN = "Then the ORIGINAL outcome holds";

const ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }],
};

// Assigned in beforeAll from the persisted symptom contract's generated id.
let CONTRACT_ID = "";

const RLS_DB_ENABLED = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = RLS_DB_ENABLED ? describe : describe.skip;

function databaseName(): string {
  return `tanren_bh15_locked_ctx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function databaseUrl(database: string, appRole = false): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${database}`;
  if (appRole) {
    url.username = "tanren_app";
    url.password = APP_PASSWORD;
  }
  return url.toString();
}
function digest(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}
const ARTIFACT = digest("bh15-artifact");

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

function contract(): SymptomContractV1 {
  return {
    version: 1,
    issueLoopId: LOOP,
    target: { url: "http://unused.local/symptom", method: "GET", path: "/symptom" },
    expectedFailingObservation: { status: 200, body: { status: "still_broken" } },
    expectedCorrectedObservation: { status: 200, body: { status: "fixed" } },
    proofPolicy: "active_causal",
    sourceRevision: CONTRACT_SOURCE_REVISION,
    baselineRequired: true,
  };
}

async function seedTenant(owner: Pool, releaseUrl: string): Promise<void> {
  const headSha = "a".repeat(40);
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [ORG],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
     VALUES ($1, $1, 'https://example.com/repo.git', 'main', 'runner:v0', $2, '{}'::jsonb)`,
    [PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO inbox_sources (id, org_id, project_id, kind, name) VALUES ($1, $2, $3, 'issues', 'src')`,
    [SOURCE, ORG, PROJECT],
  );
  await owner.query(
    `INSERT INTO issue_loops
       (org_id, id, project_id, source_id, external_key, generation, fingerprint, severity, state,
        resolution_policy, row_version, updated_at)
     VALUES ($1, $2, $3, $4, 'ext-bh15', 1, 'fp-bh15', 'high', 'open', 'active_causal', 1, now())`,
    [ORG, LOOP, PROJECT, SOURCE],
  );
  await owner.query(
    `INSERT INTO integration_nodes
       (node_id, project_id, org_id, base_branch, base_sha, ref, purpose, members, member_key, head_sha, tree_hash, status)
     VALUES ($1, $2, $3, 'main', $4, 'refs/tanren/bh15', 'merge_batch', '[]'::jsonb, 'member-bh15', $4, 'tree-bh15', 'ready')`,
    [NODE, PROJECT, ORG, headSha],
  );
  await owner.query(
    `INSERT INTO cas_artifacts (org_id, digest, byte_size, media_type, storage_backend, inline_bytes)
     VALUES ($1, $2, 1, 'application/octet-stream', 'inline_pg', '\\x00'::bytea)`,
    [ORG, ARTIFACT],
  );
  await owner.query(
    `INSERT INTO verification_environments
       (org_id, id, project_id, integration_node_id, artifact_digest, deployment_target,
        environment_fingerprint, tenant_lease_id, lifecycle_status)
     VALUES ($1, $2, $3, $4, $5, 'production', 'fp-bh15', 'lease-bh15', 'ready')`,
    [ORG, ENV, PROJECT, NODE, ARTIFACT],
  );
  await owner.query(
    `INSERT INTO release_instances
       (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
        provider_checksum, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'deploy.fixture', 'app-bh15', 'production', 'dep-bh15', $4, $5, NULL, $6, $7, 'live')`,
    [ORG, RELEASE, PROJECT, headSha, ARTIFACT, NODE, releaseUrl],
  );
  await owner.query(
    `INSERT INTO persona_revisions (id, org_id, project_id, persona_id, scope, revision_number, name, description, content_digest)
     VALUES ($1, $2, $3, 'persona-bh15', 'project', 1, 'persona', 'persona', $4)`,
    [PERSONA, ORG, PROJECT, digest("persona-bh15")],
  );
  await owner.query(
    `INSERT INTO behavior_revisions
       (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then",
        content_digest, acceptance, status)
     VALUES ($1, $2, $3, $4, $5, 1, 'behavior', $6, $7, $8, $9, $10::jsonb, 'active')`,
    [
      BOUND_REVISION,
      ORG,
      PROJECT,
      BEHAVIOR_ID,
      PERSONA,
      ORIGINAL_GIVEN,
      ORIGINAL_WHEN,
      ORIGINAL_THEN,
      digest("bound-revision-original"),
      JSON.stringify(ACCEPTANCE),
    ],
  );
  await owner.query(
    `INSERT INTO release_instance_behavior_revisions (org_id, release_instance_id, behavior_revision_id, ordinal)
     VALUES ($1, $2, $3, 0)`,
    [ORG, RELEASE, BOUND_REVISION],
  );
}

async function baselineJob(store: ResolutionJobStore, id: string): Promise<ResolutionJob> {
  await store.enqueue({
    orgId: ORG,
    projectId: PROJECT,
    id,
    issueLoopId: LOOP,
    contractId: CONTRACT_ID,
    releaseInstanceId: RELEASE,
    stage: "baseline",
    idempotencyKey: `${id}:baseline`,
  });
  const job = await store.claimNext({ orgId: ORG, leaseOwner: `worker-${id}` });
  if (job === undefined) throw new Error("expected a queued baseline job");
  return job;
}

async function productionJob(store: ResolutionJobStore, id: string): Promise<ResolutionJob> {
  await store.enqueue({
    orgId: ORG,
    projectId: PROJECT,
    id,
    issueLoopId: LOOP,
    contractId: CONTRACT_ID,
    releaseInstanceId: RELEASE,
    stage: "production",
    idempotencyKey: `${id}:production`,
  });
  const job = await store.claimNext({ orgId: ORG, leaseOwner: `worker-${id}` });
  if (job === undefined) throw new Error("expected a queued production job");
  return job;
}

async function runContextHash(pool: Pool, jobId: string): Promise<string | null> {
  const row = await runWithOrgScope(pool, ORG, (client) =>
    client.query<{ runtime_behavior_context_hash: string }>(
      `SELECT runtime_behavior_context_hash FROM behavior_verification_runs WHERE org_id = $1 AND resolution_job_id = $2`,
      [ORG, jobId],
    ),
  );
  return row.rows[0]?.runtime_behavior_context_hash ?? null;
}

describeDb("bh-15 locked behavior-context loader", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let server: Server;
  let releaseUrl = "";
  let symptomRequests = 0;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture.local").pathname;
      if (path === "/symptom") symptomRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(path === "/symptom" ? { status: "fixed" } : { status: "healthy" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fixture did not bind a port");
    releaseUrl = `http://127.0.0.1:${address.port}`;

    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: databaseUrl(database, true) });
    await seedTenant(owner, releaseUrl);
    const stored = await new SymptomContractStore(app).create({ orgId: ORG, projectId: PROJECT, contract: contract() });
    CONTRACT_ID = stored.id;
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
    await closeServer(server);
  }, 30_000);

  it("binds the BOUND revision (not the latest head) and stores one identical digest across baseline + production", async () => {
    const loader = new PgRuntimeBehaviorContextLoader({ pool: app });
    const jobs = new ResolutionJobStore(app);

    // The bound revision is loaded WHOLE with its original Given/When/Then body.
    const baseCtx = await loader.load(await productionJob(jobs, "rjob_ctx_probe_prod"));
    expect(baseCtx.behaviors).toHaveLength(1);
    expect(baseCtx.behaviors[0]).toMatchObject({
      behaviorRevisionId: BOUND_REVISION,
      given: ORIGINAL_GIVEN,
      when: ORIGINAL_WHEN,
      then: ORIGINAL_THEN,
      contentDigest: digest("bound-revision-original"),
      personaRevisionId: PERSONA,
    });
    const lockedDigest = baseCtx.contextDigest;
    expect(lockedDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    // Mutate the behavior head: a NEW revision supersedes the bound one. The
    // release binding still points at the ORIGINAL, immutable revision.
    const mutated = await runWithOrgScope(app, ORG, (client) =>
      new PgBehaviorRevisionStore(client).create({
        orgId: ORG,
        projectId: PROJECT,
        behaviorId: BEHAVIOR_ID,
        personaRevisionId: parsePersonaRevisionId(PERSONA),
        title: "behavior",
        given: "Given the CHANGED head precondition",
        when: "When the CHANGED head action runs",
        then: "Then the CHANGED head outcome holds",
        acceptance: ACCEPTANCE,
        authoringProvenance: {},
      }),
    );
    expect(mutated.id).not.toBe(BOUND_REVISION);

    // The loader STILL loads the original bound body + identical digest.
    const afterMutation = await loader.load(await productionJob(jobs, "rjob_ctx_probe_prod2"));
    expect(afterMutation.behaviors[0]).toMatchObject({ behaviorRevisionId: BOUND_REVISION, given: ORIGINAL_GIVEN });
    expect(afterMutation.contextDigest).toBe(lockedDigest);

    // Baseline and production each STORE that locked digest in the run facts.
    const baseJob = await baselineJob(jobs, "rjob_ctx_baseline");
    await new BaselineReproductionStage({ pool: app }).run(baseJob, { behaviorContext: await loader.load(baseJob) });
    const prodJob = await productionJob(jobs, "rjob_ctx_production");
    await new ProductionSymptomStage({ pool: app }).run(prodJob, { behaviorContext: await loader.load(prodJob) });

    const baselineHash = await runContextHash(app, baseJob.id);
    const productionHash = await runContextHash(app, prodJob.id);
    expect(baselineHash).toBe(lockedDigest);
    expect(productionHash).toBe(lockedDigest);
    expect(baselineHash).toBe(productionHash);
  });

  it("negative control (a): a walker constructed WITHOUT the loader fails closed at construction", () => {
    expect(
      () =>
        new ResolutionDagWalker({
          store: new ResolutionJobStore(app),
          orgIds: () => Promise.resolve([ORG]),
          stages: createResolutionStageRegistry({ pool: app }),
          leaseOwner: "walker-no-loader",
          behaviorContextLoader: undefined as unknown as RuntimeBehaviorContextLoader,
        }),
    ).toThrow(/requires a behaviorContextLoader/u);
  });

  it("negative control (b): no frozen release binding — even with a NEWER live release present — settles stale_contract and never resolves the newer release's behavior", async () => {
    // A NEWER live production release bound to a DIFFERENT behavior. A recency
    // (`ORDER BY created_at DESC`) fallback would resolve THIS release's behavior;
    // the lock must fail closed instead of drifting to it.
    const NEWER_RELEASE = "release_bh15_newer";
    const OTHER_BEHAVIOR_ID = "behavior_bh15_other";
    const OTHER_REVISION = "behavior_revision_bh15_other";
    const OTHER_GIVEN = "Given the NEWER release behavior that must NEVER be loaded";
    await owner.query(
      `INSERT INTO behavior_revisions
         (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then",
          content_digest, acceptance, status)
       VALUES ($1, $2, $3, $4, $5, 1, 'other', $6, 'w', 't', $7, $8::jsonb, 'active')`,
      [
        OTHER_REVISION,
        ORG,
        PROJECT,
        OTHER_BEHAVIOR_ID,
        PERSONA,
        OTHER_GIVEN,
        digest("other-rev"),
        JSON.stringify(ACCEPTANCE),
      ],
    );
    await owner.query(
      `INSERT INTO release_instances
         (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest,
          provider_checksum, integration_node_id, url, state, created_at)
       VALUES ($1, $2, $3, 'deploy.fixture', 'app-bh15', 'production', 'dep-bh15-newer', $4, $5, NULL, $6, $7, 'live', now() + interval '1 hour')`,
      [ORG, NEWER_RELEASE, PROJECT, "b".repeat(40), ARTIFACT, NODE, releaseUrl],
    );
    await owner.query(
      `INSERT INTO release_instance_behavior_revisions (org_id, release_instance_id, behavior_revision_id, ordinal)
       VALUES ($1, $2, $3, 0)`,
      [ORG, NEWER_RELEASE, OTHER_REVISION],
    );

    const loader = new PgRuntimeBehaviorContextLoader({ pool: app });
    // A production job with NO frozen release binding (reachable via the steer command).
    const unsetJob: ResolutionJob = {
      id: "rjob_neg_unset",
      orgId: ORG,
      projectId: PROJECT,
      issueLoopId: LOOP,
      contractId: CONTRACT_ID,
      stage: "production",
      state: "running",
      leaseOwner: "worker-neg",
      leaseExpiry: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "rjob_neg_unset:production",
      attempt: 1,
    };
    let failure: unknown;
    try {
      await loader.load(unsetJob);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LockedBehaviorContextError);
    // Fails on the MISSING binding — it never fell through to the newer release.
    expect((failure as LockedBehaviorContextError).reason).toBe("missing_release_binding");
    expect((failure as LockedBehaviorContextError).classification).toBe("stale_contract");

    // Drive the LIVE walker path (real loader + real registry) with an unset job.
    // The probe, the ResolutionAuthority, and the source-close outbox must never run,
    // and the newer release's behavior must never be loaded into a run.
    let authorizeCalls = 0;
    const authority: ResolutionAuthority = {
      authorize: async () => {
        authorizeCalls += 1;
        return { id: "rdec_neg", decision: "authorized", inputSnapshotHash: digest("neg"), reasons: [], created: true };
      },
      waive: () => Promise.reject(new Error("waive must not run")),
    };
    const symptomBefore = symptomRequests;
    await new ResolutionJobStore(app).enqueue({
      orgId: ORG,
      projectId: PROJECT,
      id: "rjob_neg_walker",
      issueLoopId: LOOP,
      contractId: CONTRACT_ID,
      // deliberately NO releaseInstanceId
      stage: "production",
      idempotencyKey: "rjob_neg_walker:production",
    });
    const walker = new ResolutionDagWalker({
      store: new ResolutionJobStore(app),
      orgIds: () => Promise.resolve([ORG]),
      stages: createResolutionStageRegistry({ pool: app }),
      leaseOwner: "walker-bh15-neg",
      authority,
      behaviorContextLoader: loader,
    });
    await walker.tick();

    const jobState = await runWithOrgScope(app, ORG, (client) =>
      client.query<{ state: string }>(`SELECT state FROM resolution_jobs WHERE org_id = $1 AND id = $2`, [
        ORG,
        "rjob_neg_walker",
      ]),
    );
    // stale_contract is terminal; the probe, authority, run, and source-close never ran.
    expect(jobState.rows[0]?.state).toBe("completed");
    expect(authorizeCalls).toBe(0);
    expect(symptomRequests).toBe(symptomBefore);
    expect(await runContextHash(app, "rjob_neg_walker")).toBeNull();
    const usedNewerBehavior = await runWithOrgScope(app, ORG, (client) =>
      client.query(
        `SELECT 1
           FROM behavior_verification_runs r
           JOIN behavior_verification_attempts a ON a.org_id = r.org_id AND a.run_id = r.id
           JOIN behavior_verification_plans p ON p.org_id = a.org_id AND p.id = a.plan_id
          WHERE r.org_id = $1 AND p.behavior_revision_id = $2`,
        [ORG, OTHER_REVISION],
      ),
    );
    expect(usedNewerBehavior.rowCount).toBe(0);
    const closes = await runWithOrgScope(app, ORG, (client) =>
      client.query(
        `SELECT 1 FROM source_sync_outbox WHERE org_id = $1 AND issue_loop_id = $2 AND operation = 'close'`,
        [ORG, LOOP],
      ),
    );
    expect(closes.rowCount).toBe(0);
  });

  it("negative control (c): an EMPTY bound set settles stale_contract and never substitutes the latest head", async () => {
    // Remove RELEASE's binding so it delivers NO bound behaviors; the newer active
    // head from the head-mutation above still exists and must NOT be substituted.
    await owner.query(
      `DELETE FROM release_instance_behavior_revisions WHERE org_id = $1 AND release_instance_id = $2`,
      [ORG, RELEASE],
    );
    const activeHead = await owner.query(
      `SELECT id FROM behavior_revisions WHERE org_id = $1 AND behavior_id = $2 AND status = 'active'`,
      [ORG, BEHAVIOR_ID],
    );
    expect(activeHead.rows).toHaveLength(1);
    expect(activeHead.rows[0]?.id).not.toBe(BOUND_REVISION);

    const loader = new PgRuntimeBehaviorContextLoader({ pool: app });
    const emptyJob: ResolutionJob = {
      id: "rjob_neg_empty",
      orgId: ORG,
      projectId: PROJECT,
      issueLoopId: LOOP,
      contractId: CONTRACT_ID,
      releaseInstanceId: RELEASE,
      stage: "production",
      state: "running",
      leaseOwner: "worker-empty",
      leaseExpiry: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: "rjob_neg_empty:production",
      attempt: 1,
    };
    let failure: unknown;
    try {
      await loader.load(emptyJob);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(LockedBehaviorContextError);
    expect((failure as LockedBehaviorContextError).reason).toBe("empty_binding");
    expect((failure as LockedBehaviorContextError).classification).toBe("stale_contract");
  });
});
