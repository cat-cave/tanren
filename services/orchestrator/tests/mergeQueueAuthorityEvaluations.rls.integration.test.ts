// cspell:ignore mqeval mqgrp
import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { CodeHost } from "../src/engine/contracts/codeHost.js";
import { MergeAuthorityV2Impl, type AuthorityLandStore } from "../src/engine/merge/mergeAuthorityV2Impl.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueAuthorityEvaluationRoutes } from "../src/routes/mergeQueue/authorityEvaluations.js";
import {
  buildBatchGateProofEvidence,
  MultiMemberAuthorityInfrastructureFault,
  PgExactBatchBindingRevalidator,
  PgIntegrationNodeModel,
} from "./helpers/mq2BatchAuthority.js";
import { seedMq2Tenant, type Mq2TenantFixture } from "./helpers/mq2AuthorityRlsFixture.js";
import { activeQuarantineVersion, loadActiveQuarantine } from "../src/engine/workflow/ciQuarantine.js";

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
  let fixtureA: Mq2TenantFixture;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });
    fixtureA = await seedMq2Tenant({
      owner: ownerPool,
      orgId: ORG_A,
      projectId: PROJECT_A,
      label: "A",
      evaluationId: W0_EVALUATION,
    });
    await seedMq2Tenant({
      owner: ownerPool,
      orgId: ORG_B,
      projectId: PROJECT_B,
      label: "B",
      evaluationId: W0_EVALUATION,
    });
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
    let hostLandCalls = 0;
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
      async landAuthorizedIntegration() {
        hostLandCalls += 1;
        return { mainSha: fixtureA.binding.headSha };
      },
    } as unknown as CodeHost;
    let v2BundlePresent = true;
    const revalidator = new PgExactBatchBindingRevalidator({
      orgId: ORG_A,
      binding: fixtureA.binding,
      envelope: fixtureA.envelope,
      host,
      repo: { owner: "cat-cave", name: "tanren" },
      intoMain: "main",
      nodes: new PgIntegrationNodeModel(runtimePool),
      verifyGateProof: async () => v2BundlePresent,
      readQuarantineVersion: async () => fixtureA.binding.proof.keyInput.quarantineVersion,
      readDecisionSignals: async () => ({ gateVerdict: "passed", mergeability: "clean", conflicts: "resolved" }),
    });
    const validate = () => revalidator.revalidate({ subject: fixtureA.envelope.subject, envelope: fixtureA.envelope });

    await expect(validate()).resolves.toEqual({ valid: true });

    v2BundlePresent = false;
    await expect(validate()).resolves.toMatchObject({ valid: false });
    v2BundlePresent = true;

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

    // A changed required-section seal is a V2 failure before the host read.
    v2BundlePresent = false;
    await expect(validate()).resolves.toMatchObject({ valid: false });
    v2BundlePresent = true;

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

    // V2 must stop before the host port when the durable exact bundle disappears.
    // This executes the production PG revalidator, not a permissive in-memory double.
    v2BundlePresent = false;
    const authority = new MergeAuthorityV2Impl(host, revalidator, {
      persistAuthorizedDecision: async () => ({ effectIntentId: "must-not-be-persisted" }),
      recordLandReceipt: async () => ({ auditId: "must-not-be-recorded" }),
    } as AuthorityLandStore);
    const authorization = await authority.authorizeLand(
      {
        subject: fixtureA.envelope.subject,
        gateVerdict: "passed",
        findings: [],
        auditPosture: { blockReviewAt: "P1", p2p3Handling: "route-to-dag" },
        reviewVerdict: "approved",
        mergeability: "clean",
        budget: { kind: "not_required" },
        demo: "not_required",
        hitlSignoff: "not_required",
        conflicts: "resolved",
      },
      fixtureA.envelope,
    );
    expect(authorization).toMatchObject({
      decision: "blocked",
      reasons: [expect.objectContaining({ input: "binding" })],
    });
    await expect(authority.land(authorization)).rejects.toThrow(/not 'authorized'/u);
    expect(hostLandCalls).toBe(0);
    v2BundlePresent = true;
  });

  it("projects flake_observation on the read side only from the exact active quarantine and passing proof epoch", async () => {
    // The engine gather no longer synthesizes flake evidence (removed): flake_observation
    // is reconstructed on the durable read side from a real ci-flaky quarantine row whose
    // proven toggle attests THIS exact head, joined to a passing batch proof. Prove that
    // read-side projection against real Postgres, and that a head mismatch removes it.
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
    const version = await runWithOrgScope(runtimePool, ORG_A, async (client) =>
      activeQuarantineVersion(await loadActiveQuarantine(client, PROJECT_A)),
    );
    const keyInput = {
      memberKey: fixtureA.binding.memberSetHash,
      gateConfigHash: fixtureA.binding.gateConfigHash,
      policyVersion: fixtureA.binding.policyVersion,
      runnerImage: "runner@sha256:flake-observation",
      appEnvHash: "env-flake-observation",
      quarantineVersion: version,
    };
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
    // The engine gather now returns only the durable persisted signals (no synthesized flake).

    const listPath = `/orgs/${ORG_A}/projects/${PROJECT_A}/merge-queue/authority-evaluations`;
    const flakeBody = (await (await app.request(listPath)).json()) as {
      evaluations: Array<{ kind: string; source: string; sourceId: string; reasonCodes: string[] }>;
    };
    const flake = flakeBody.evaluations.find((evaluation) => evaluation.kind === "flake_observation");
    expect(flake).toMatchObject({
      kind: "flake_observation",
      source: "quarantine",
      sourceId: "quarantine-exact-toggle",
      reasonCodes: ["same_tree_nondeterminism"],
    });

    await scopedUpdate(
      ownerPool,
      ORG_A,
      `UPDATE quarantined_tests SET evidence = jsonb_set(evidence, '{sampleShas}', '["other-head"]'::jsonb)
        WHERE id = 'quarantine-exact-toggle'`,
      [],
    );
    const mismatched = (await (await app.request(listPath)).json()) as { evaluations: Array<{ kind: string }> };
    expect(mismatched.evaluations.some((evaluation) => evaluation.kind === "flake_observation")).toBe(false);
  });
});

async function scopedUpdate(pool: Pool, orgId: string, sql: string, values: ReadonlyArray<unknown>): Promise<void> {
  await runWithOrgScope(pool, orgId, async (client) => {
    await client.query(sql, [...values]);
  });
}
