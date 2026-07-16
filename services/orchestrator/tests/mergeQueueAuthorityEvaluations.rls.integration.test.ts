// cspell:ignore mqeval mqgrp
import { createHash } from "node:crypto";
import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { CodeHost } from "../src/engine/contracts/codeHost.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueAuthorityEvaluationRoutes } from "../src/routes/mergeQueue/authorityEvaluations.js";
import {
  activeQuarantineVersion,
  batchArtifactDigest,
  batchProofRoot,
  buildBatchGateProofEvidence,
  loadBatchDecisionEvidence,
  loadCurrentQuarantineVersion,
  loadPersistedBatchDecisionSignals,
  memberKey,
  MultiMemberAuthorityInfrastructureFault,
  PgExactBatchBindingRevalidator,
  PgIntegrationNodeModel,
  proofReuseKey,
  type BatchAuthorityBinding,
  type LandBindingEnvelope,
} from "./helpers/mq2BatchAuthority.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_mq2_a";
const ORG_B = "org_mq2_b";
const PROJECT_A = "project_mq2_a";
const PROJECT_B = "project_mq2_b";
const W0_EVALUATION = `mqeval_${"a".repeat(64)}`;

const actorA: ActorContext = {
  userId: "user_mq2_a",
  orgId: ORG_A,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface TenantFixture {
  readonly binding: BatchAuthorityBinding;
  readonly envelope: LandBindingEnvelope;
  readonly proofEvidence: unknown;
}

function dbName(): string {
  return `tanren_mq2_rls_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function runtimeUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.username = "tanren_app";
  parsed.password = APP_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function buildApp(pool: Pool): Hono<ActorContextEnv> {
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actorA;
        },
      } as never,
      localDevActor: actorA,
    }),
  );
  app.route("/orgs", createMergeQueueAuthorityEvaluationRoutes({ pool }));
  return app;
}

describeDb("mq-2 durable authority evaluation under enforced RLS", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;
  let app: Hono<ActorContextEnv>;
  let fixtureA: TenantFixture;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });
    fixtureA = await seedTenant(ownerPool, ORG_A, PROJECT_A, "A");
    await seedTenant(ownerPool, ORG_B, PROJECT_B, "B");
    app = buildApp(runtimePool);
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("reconstructs org A's exact green decision and conceals every org B path", async () => {
    const own = await app.request(`/orgs/${ORG_A}/projects/${PROJECT_A}/merge-queue/authority-evaluations`);
    expect(own.status).toBe(200);
    const body = (await own.json()) as {
      evaluations: Array<{ kind: string; members: Array<{ specId: string; runId: string | null }> }>;
    };
    const authorized = body.evaluations.find((evaluation) => evaluation.kind === "authorized_subset");
    expect(authorized?.members).toEqual([
      expect.objectContaining({ specId: "A1", runId: "run-A1" }),
      expect.objectContaining({ specId: "A2", runId: "run-A2" }),
    ]);

    const ownW0 = await app.request(
      `/orgs/${ORG_A}/projects/${PROJECT_A}/merge-queue/authority-evaluations/${W0_EVALUATION}`,
    );
    expect(ownW0.status).toBe(200);
    const w0 = (await ownW0.json()) as { evaluation: { members: Array<{ specId: string }> } };
    expect(w0.evaluation.members).toEqual([expect.objectContaining({ specId: "A" })]);

    const crossOrg = await app.request(
      `/orgs/${ORG_B}/projects/${PROJECT_B}/merge-queue/authority-evaluations/${W0_EVALUATION}`,
    );
    const crossProject = await app.request(
      `/orgs/${ORG_A}/projects/${PROJECT_B}/merge-queue/authority-evaluations/${W0_EVALUATION}`,
    );
    expect(crossOrg.status).toBe(404);
    expect(crossProject.status).toBe(404);
  });

  it("exposes no durable authority substrate without an org scope", async () => {
    for (const table of [
      "events",
      "integration_nodes",
      "integration_proofs",
      "authority_decisions",
      "quarantined_tests",
    ]) {
      const result = await runtimePool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
      expect(Number(result.rows[0]?.n)).toBe(0);
    }
  });

  it("revalidates the exact RLS-scoped binding and rejects proof/tree/epoch/member or host drift", async () => {
    const refs = new Map<string, string>([
      ["main", fixtureA.binding.baseSha],
      ...fixtureA.binding.members.map((member) => [member.branch, member.headSha] as const),
    ]);
    let hostError: Error | undefined;
    const host = {
      async fetchRef(input: { remoteBranch: string }) {
        if (hostError !== undefined) {
          if ("retriable" in hostError) {
            throw Object.assign(new Error(hostError.message, { cause: hostError }), {
              retriable: Reflect.get(hostError, "retriable"),
            });
          }
          throw new Error(hostError.message, { cause: hostError });
        }
        return refs.get(input.remoteBranch);
      },
    } as unknown as CodeHost;
    const revalidator = new PgExactBatchBindingRevalidator({
      orgId: ORG_A,
      binding: fixtureA.binding,
      envelope: fixtureA.envelope,
      host,
      repo: { owner: "cat-cave", name: "tanren" },
      intoMain: "main",
      nodes: new PgIntegrationNodeModel(runtimePool),
      readQuarantineVersion: () => loadCurrentQuarantineVersion(runtimePool, ORG_A, PROJECT_A),
      readDecisionSignals: () => loadPersistedBatchDecisionSignals(runtimePool, ORG_A, PROJECT_A, fixtureA.binding),
    });
    const validate = () => revalidator.revalidate({ subject: fixtureA.envelope.subject, envelope: fixtureA.envelope });

    await expect(validate()).resolves.toEqual({ valid: true });

    await scopedUpdate(
      ownerPool,
      ORG_A,
      `UPDATE integration_proofs SET evidence = jsonb_set(evidence, '{treeHash}', '"stale-tree"'::jsonb)
        WHERE project_id = $1 AND proof_reuse_key = $2`,
      [PROJECT_A, fixtureA.binding.proof.proofReuseKey],
    );
    await expect(validate()).resolves.toMatchObject({ valid: false });
    await scopedUpdate(
      ownerPool,
      ORG_A,
      `UPDATE integration_proofs SET evidence = $3::jsonb
        WHERE project_id = $1 AND proof_reuse_key = $2`,
      [PROJECT_A, fixtureA.binding.proof.proofReuseKey, JSON.stringify(fixtureA.proofEvidence)],
    );

    await scopedUpdate(
      ownerPool,
      ORG_A,
      `UPDATE integration_nodes SET tree_hash = 'stale-tree' WHERE project_id = $1 AND node_id = $2`,
      [PROJECT_A, fixtureA.binding.nodeId],
    );
    await expect(validate()).resolves.toMatchObject({ valid: false });
    await scopedUpdate(
      ownerPool,
      ORG_A,
      `UPDATE integration_nodes SET tree_hash = $3 WHERE project_id = $1 AND node_id = $2`,
      [PROJECT_A, fixtureA.binding.nodeId, fixtureA.binding.treeHash],
    );

    const mutatedMembers = fixtureA.binding.members.map((member, index) =>
      index === 1 ? { ...member, runId: "run-mutated" } : member,
    );
    await scopedUpdate(
      ownerPool,
      ORG_A,
      `UPDATE integration_nodes SET members = $3::jsonb WHERE project_id = $1 AND node_id = $2`,
      [PROJECT_A, fixtureA.binding.nodeId, JSON.stringify(mutatedMembers)],
    );
    await expect(validate()).resolves.toMatchObject({ valid: false });
    await scopedUpdate(
      ownerPool,
      ORG_A,
      `UPDATE integration_nodes SET members = $3::jsonb WHERE project_id = $1 AND node_id = $2`,
      [PROJECT_A, fixtureA.binding.nodeId, JSON.stringify(fixtureA.binding.members)],
    );

    await scopedUpdate(
      ownerPool,
      ORG_A,
      `INSERT INTO quarantined_tests
         (id, project_id, check_name, test_id, toggled_sha_count, observation_count, evidence)
       VALUES ('quarantine-epoch-drift', $1, 'unit', 'suite#drift', 1, 2, $2::jsonb)`,
      [
        PROJECT_A,
        JSON.stringify({
          checkName: "unit",
          testId: "suite#drift",
          toggledShaCount: 1,
          observationCount: 2,
          sampleShas: [fixtureA.binding.headSha],
        }),
      ],
    );
    await expect(validate()).resolves.toMatchObject({ valid: false });
    await scopedUpdate(ownerPool, ORG_A, `DELETE FROM quarantined_tests WHERE id = 'quarantine-epoch-drift'`, []);

    refs.set("main", "main-advanced");
    await expect(validate()).resolves.toMatchObject({ valid: false });
    refs.set("main", fixtureA.binding.baseSha);
    refs.set(fixtureA.binding.members[0]!.branch, "member-advanced");
    await expect(validate()).resolves.toMatchObject({ valid: false });
    refs.set(fixtureA.binding.members[0]!.branch, fixtureA.binding.members[0]!.headSha);

    hostError = Object.assign(new Error("temporary provider outage"), { retriable: true });
    await expect(validate()).rejects.toBeInstanceOf(MultiMemberAuthorityInfrastructureFault);
    hostError = new Error("credential configuration invalid");
    await expect(validate()).rejects.toThrow("credential configuration invalid");
    hostError = undefined;
    await expect(validate()).resolves.toEqual({ valid: true });
  });

  it("gathers same-tree flake evidence only from the exact active quarantine and passing proof epoch", async () => {
    const quarantineEvidence = {
      checkName: "unit",
      testId: "suite#toggle",
      toggledShaCount: 1,
      observationCount: 2,
      sampleShas: [fixtureA.binding.headSha],
    };
    await scopedUpdate(
      ownerPool,
      ORG_A,
      `INSERT INTO quarantined_tests
         (id, project_id, check_name, test_id, toggled_sha_count, observation_count, evidence)
       VALUES ('quarantine-exact-toggle', $1, 'unit', 'suite#toggle', 1, 2, $2::jsonb)`,
      [PROJECT_A, JSON.stringify(quarantineEvidence)],
    );
    const version = await loadCurrentQuarantineVersion(runtimePool, ORG_A, PROJECT_A);
    const keyInput = { ...fixtureA.binding.proof.keyInput, quarantineVersion: version };
    const proofKey = proofReuseKey(keyInput);
    const proofEvidence = buildBatchGateProofEvidence({
      nodeId: fixtureA.binding.nodeId,
      headSha: fixtureA.binding.headSha,
      treeHash: fixtureA.binding.treeHash,
      memberSetHash: fixtureA.binding.memberSetHash,
      keyInput,
      passed: true,
    });
    await new PgIntegrationNodeModel(ownerPool).recordProof({
      orgId: ORG_A,
      projectId: PROJECT_A,
      nodeId: fixtureA.binding.nodeId,
      keyInput,
      verdict: "passed",
      evidence: proofEvidence,
    });
    const binding: BatchAuthorityBinding = {
      ...fixtureA.binding,
      proof: { verdict: "passed", proofReuseKey: proofKey, keyInput },
    };

    const gathered = await loadBatchDecisionEvidence(runtimePool, ORG_A, PROJECT_A, binding);
    expect(gathered.persisted).toEqual({ gateVerdict: "passed", mergeability: "clean", conflicts: "resolved" });
    expect(gathered.evidence).toEqual({
      kind: "same_tree_flake",
      treeHash: binding.treeHash,
      quarantineVersion: version,
      observations: [
        { id: "quarantine-exact-toggle:failed", verdict: "failed" },
        { id: "quarantine-exact-toggle:passed", verdict: "passed" },
      ],
    });

    await scopedUpdate(
      ownerPool,
      ORG_A,
      `UPDATE quarantined_tests SET evidence = jsonb_set(evidence, '{sampleShas}', '["other-head"]'::jsonb)
        WHERE id = 'quarantine-exact-toggle'`,
      [],
    );
    const malformed = await loadBatchDecisionEvidence(runtimePool, ORG_A, PROJECT_A, binding);
    expect(malformed.evidence).toBeUndefined();
  });
});

async function seedTenant(owner: Pool, orgId: string, projectId: string, label: string): Promise<TenantFixture> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, $1, $2, $3)`,
    [projectId, `https://example.com/${projectId}.git`, orgId],
  );
  await runWithOrgScope(owner, orgId, async (client) => {
    await new PgEventStore(client).append({
      projectId,
      orgId,
      eventType: "merge.signal.classified",
      payload: {
        missionNodeId: "mq-1",
        evaluationId: W0_EVALUATION,
        groupId: `mqgrp_${"b".repeat(64)}`,
        memberIds: [label],
        findingIds: [`finding-${label}`],
        signalVersion: "merge_signal.v1",
        classification: "deterministic_policy",
        reasonCode: "audit_policy",
        retryability: "non_retryable",
        wakeKey: null,
        disposition: "member_repair",
      },
    });
  });

  const members = [
    { specId: `${label}1`, runId: `run-${label}1`, branch: `feature/${label}1`, headSha: `sha-${label}1` },
    { specId: `${label}2`, runId: `run-${label}2`, branch: `feature/${label}2`, headSha: `sha-${label}2` },
  ];
  const baseSha = `base-${label}`;
  const headSha = `batch-${label}`;
  const treeHash = `tree-${label}`;
  const key = memberKey(
    baseSha,
    members.map((member) => member.headSha),
  );
  const keyInput = {
    memberKey: key,
    gateConfigHash: "gate-v1",
    policyVersion: "policy-v1",
    runnerImage: "runner@sha256:abc",
    appEnvHash: "env-v1",
    quarantineVersion: activeQuarantineVersion({ checkNames: new Set(), testIds: [] }),
  };
  const nodes = new PgIntegrationNodeModel(owner);
  const nodeId = await nodes.upsertNode({
    projectId,
    orgId,
    baseBranch: "main",
    baseSha,
    ref: `tanren-local-${label}`,
    purpose: "merge_batch",
    members,
    gateConfigHash: keyInput.gateConfigHash,
    policyVersion: keyInput.policyVersion,
    headSha,
    treeHash,
    status: "ready",
  });
  const proofEvidence = buildBatchGateProofEvidence({
    nodeId,
    headSha,
    treeHash,
    memberSetHash: key,
    keyInput,
    passed: true,
  });
  const proofKey = await nodes.recordProof({
    orgId,
    projectId,
    nodeId,
    keyInput,
    verdict: "passed",
    evidence: proofEvidence,
  });
  expect(proofKey).toBe(proofReuseKey(keyInput));
  await runWithOrgScope(owner, orgId, (client) =>
    client.query(
      `INSERT INTO authority_decisions
         (org_id, project_id, id, integration_node_id, subject_kind, head_sha, expected_main_sha,
          artifact_digest, proof_root, member_set_hash, policy_version, decision)
       VALUES ($1,$2,$3,$4,'integration_node',$5,$6,$7,$8,$9,$10,'authorized')`,
      [
        orgId,
        projectId,
        `decision-${label}`,
        nodeId,
        headSha,
        baseSha,
        artifactDigest(headSha, treeHash),
        `sha256:${proofKey}`,
        key,
        keyInput.policyVersion,
      ],
    ),
  );
  const binding: BatchAuthorityBinding = {
    nodeId,
    baseBranch: "main",
    baseSha,
    headSha,
    treeHash,
    members,
    memberSetHash: key,
    policyVersion: keyInput.policyVersion,
    proof: { verdict: "passed", proofReuseKey: proofKey, keyInput },
  };
  const envelope: LandBindingEnvelope = {
    subject: { kind: "integration_node", id: nodeId },
    members: members.map((member) => ({ ...member, disposition: "admit" })),
    headSha,
    expectedMainSha: baseSha,
    artifactDigest: batchArtifactDigest(binding),
    proofRoot: batchProofRoot(binding),
    memberSetHash: key,
    policyVersion: keyInput.policyVersion,
    target: { repo: { owner: "cat-cave", name: "tanren" }, intoMain: "main" },
  };
  return { binding, envelope, proofEvidence };
}

async function scopedUpdate(pool: Pool, orgId: string, sql: string, values: ReadonlyArray<unknown>): Promise<void> {
  await runWithOrgScope(pool, orgId, async (client) => {
    await client.query(sql, [...values]);
  });
}

function artifactDigest(headSha: string, treeHash: string): string {
  return `sha256:${createHash("sha256")
    .update("tanren:merge-batch-artifact:v1\0")
    .update(headSha)
    .update("\0")
    .update(treeHash)
    .digest("hex")}`;
}
