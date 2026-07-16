import { migrate, runWithOrgScope } from "@tanren/db";
import { Hono } from "hono";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { PgCasByteStore } from "../src/engine/cas/pgCasByteStore.js";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { PgIntegrationNodeModel } from "../src/engine/dag/integrationNodesPg.js";
import type { JjLocalIntegrationResult } from "../src/engine/dag/jjLocalIntegration.js";
import { PgEventStore } from "../src/engine/eventStore.js";
import { driveBatchThroughNode } from "../src/engine/merge/batchIntegrationNodeDrive.js";
import { BehaviorCoverageEdgesStore } from "../src/engine/repositories/behaviorCoverageEdges.js";
import { buildCoverageAuthorityReadyNodeMaterializer } from "../src/engine/runtimeVerification/coverageAuthorityMaterializer.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createBehaviorCoverageRoutes } from "../src/routes/behaviorCoverage/index.js";

// cspell:ignore locktype plpgsql xact

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_rv4_production";
const PROJECT = "project_rv4_production";
const BEHAVIOR_A = "behavior_rv4_production_a" as BehaviorRevisionId;
const BEHAVIOR_B = "behavior_rv4_production_b" as BehaviorRevisionId;
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const TREE_HASH = "3".repeat(40);
const MEMBER_SHA = "4".repeat(40);
const ADVISORY_KEY = 7_404_004;

const actor: ActorContext = {
  userId: "rv4-admin",
  orgId: ORG,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const target: RunnerHandle = {
  backend: "ssh",
  host: "runner",
  port: 22,
  username: "tanren",
  hostKeyFingerprint: "SHA256:rv4-production",
  identitySecretRef: "runner/rv4-production",
};

class DiffSubstrate implements CommandSubstrate {
  readonly commands: RunnerCommand[] = [];

  async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: "src/a.ts\0", stderr: "" };
  }
}

function databaseName(): string {
  return `tanren_rv4_production_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(url: string, database: string, role?: { user: string; password: string }): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (role !== undefined) {
    parsed.username = role.user;
    parsed.password = role.password;
  }
  return parsed.toString();
}

async function seedBehavior(
  owner: Pool,
  behaviorRevisionId: BehaviorRevisionId,
  personaId: string,
  digestCharacter: string,
): Promise<void> {
  await owner.query(
    `INSERT INTO persona_revisions
       (id, org_id, project_id, persona_id, scope, revision_number, name, description,
        content_digest, authoring_provenance)
     VALUES ($1, $2, $3, $1, 'project', 1, $1, 'rv4 production proof', $4, '{}'::jsonb)`,
    [personaId, ORG, PROJECT, `sha256:${digestCharacter.repeat(64)}`],
  );
  await owner.query(
    `INSERT INTO behavior_revisions
       (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title,
        given, "when", "then", content_digest, authoring_provenance)
     VALUES ($1, $2, $3, $1, $4, 1, $1, 'given', 'when', 'then', $5, '{}'::jsonb)`,
    [behaviorRevisionId, ORG, PROJECT, personaId, `sha256:${digestCharacter.repeat(64)}`],
  );
}

function nodeInput(baseSha: string, headSha: string, treeHash: string, memberSha: string) {
  return {
    projectId: PROJECT,
    orgId: ORG,
    baseBranch: "main",
    baseSha,
    ref: `tanren/rv4/${baseSha.slice(0, 6)}`,
    purpose: "merge_batch" as const,
    members: [{ specId: `spec_${memberSha.slice(0, 6)}`, runId: "run_rv4", branch: "rv4", headSha: memberSha }],
    headSha,
    treeHash,
  };
}

async function waitForAdvisoryWaiter(owner: Pool): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await owner.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
    );
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("materializer did not reach the advisory-locked final ready update");
}

describeDb("RV4 production authority — diff → PG node → HTTP → CAS/event → replay", () => {
  const database = databaseName();
  let ownerPool: Pool;
  let appPool: Pool;
  let app: Hono<ActorContextEnv>;
  let primaryNodeId: string;
  let primaryDiff: DiffSubstrate;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({
      connectionString: databaseUrl(ADMIN_URL, database, { user: "tanren_app", password: APP_PASSWORD }),
    });
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'rv4', 'https://example.test/rv4.git', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
      [PROJECT, ORG],
    );
    await seedBehavior(ownerPool, BEHAVIOR_A, "persona_rv4_production_a", "a");
    await seedBehavior(ownerPool, BEHAVIOR_B, "persona_rv4_production_b", "b");
    await runWithOrgScope(appPool, ORG, async (client) => {
      await BehaviorCoverageEdgesStore.record(
        client,
        { orgId: ORG, projectId: PROJECT },
        { behaviorRevisionId: BEHAVIOR_A, kind: "source", targetRef: "src/a.ts" },
      );
      await BehaviorCoverageEdgesStore.record(
        client,
        { orgId: ORG, projectId: PROJECT },
        { behaviorRevisionId: BEHAVIOR_B, kind: "source", targetRef: "src/b.ts" },
      );
    });

    primaryDiff = new DiffSubstrate();
    primaryNodeId = await buildCoverageAuthorityReadyNodeMaterializer(appPool)({
      ...nodeInput(BASE_SHA, HEAD_SHA, TREE_HASH, MEMBER_SHA),
      workspace: { ssh: primaryDiff, target, workspacePath: "/workspace/rv4" },
    });

    app = new Hono<ActorContextEnv>();
    app.use("*", async (context, next) => {
      context.set("actor", actor);
      await next();
    });
    app.route("/orgs", createBehaviorCoverageRoutes({ pool: appPool, cas: new PgCasByteStore(appPool) }));
  }, 60_000);

  afterAll(async () => {
    await appPool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  async function analyze(nodeId: string, targetRef = "src/a.ts") {
    return app.request(`/orgs/${ORG}/projects/${PROJECT}/behavior-coverage/affected-selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ integrationNodeId: nodeId, targets: [{ kind: "source", targetRef }] }),
    });
  }

  it("lands targeted evidence through the production stores and replays the exact immutable fact", async () => {
    expect(primaryDiff.commands).toHaveLength(1);
    const node = await ownerPool.query<{ base_sha: string; affected_fingerprint: string; status: string }>(
      "SELECT base_sha, affected_fingerprint, status FROM integration_nodes WHERE node_id = $1",
      [primaryNodeId],
    );
    expect(node.rows[0]).toMatchObject({ base_sha: BASE_SHA, status: "ready" });
    expect(node.rows[0]?.affected_fingerprint).toMatch(/^rv4\.coverage-authority\.v1\|/u);

    const response = await analyze(primaryNodeId);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      selection: {
        analysisId: string;
        mode: string;
        selected: Array<{ behaviorRevisionId: string }>;
        excluded: Array<{ behaviorRevisionId: string }>;
      };
    };
    expect(body.selection.mode).toBe("targeted");
    expect(body.selection.selected.map((item) => item.behaviorRevisionId)).toEqual([BEHAVIOR_A]);
    expect(body.selection.excluded.map((item) => item.behaviorRevisionId)).toEqual([BEHAVIOR_B]);

    const [cas, event] = await Promise.all([
      ownerPool.query("SELECT inline_bytes FROM cas_artifacts WHERE org_id = $1 AND digest = $2", [
        ORG,
        body.selection.analysisId,
      ]),
      ownerPool.query(
        `SELECT payload FROM events
          WHERE org_id = $1 AND project_id = $2
            AND event_type = 'behavior.coverage.selection_analyzed'
            AND payload->>'analysisId' = $3`,
        [ORG, PROJECT, body.selection.analysisId],
      ),
    ]);
    expect(cas.rowCount).toBe(1);
    expect(event.rowCount).toBe(1);

    const id = encodeURIComponent(body.selection.analysisId);
    expect(
      (await app.request(`/orgs/${ORG}/projects/${PROJECT}/behavior-coverage/affected-selections/${id}`)).status,
    ).toBe(200);
    const replay = await app.request(
      `/orgs/${ORG}/projects/${PROJECT}/behavior-coverage/affected-selections/${id}/verify`,
      { method: "POST" },
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ verification: { status: "current" } });
  });

  it("routes the batch verdict producer through the real authority materializer and PG node store", async () => {
    const batchBase = "5".repeat(40);
    const batchHead = "6".repeat(40);
    const batchTree = "7".repeat(40);
    const batchMember = "8".repeat(40);
    const diff = new DiffSubstrate();
    const integrated: Extract<JjLocalIntegrationResult, { outcome: "integrated" }> = {
      outcome: "integrated",
      localRef: "tanren-local-batch-spec_rv4_batch",
      baseSha: batchBase,
      headSha: batchHead,
      treeHash: batchTree,
      memberHeadShas: { spec_rv4_batch: batchMember },
    };
    const verdict = await driveBatchThroughNode(
      {
        orgId: ORG,
        projectId: PROJECT,
        baseBranch: "main",
        baseSha: batchBase,
        repoUrl: "https://example.test/rv4.git",
        runnerImage: "runner:v0",
        tailSpecId: "spec_rv4_batch",
        members: [{ specId: "spec_rv4_batch", branch: "rv4-batch" }],
        policyVersion: "1",
        quarantineVersion: "1",
      },
      {
        nodes: new PgIntegrationNodeModel(appPool),
        eventStore: new PgEventStore(appPool),
        jjWorkspaceDeps: { ssh: diff } as never,
        integrate: async (_deps, _input, continuation) => ({
          outcome: "integrated",
          value: await continuation({ target, workspacePath: "/workspace/rv4-batch" } as never, integrated),
        }),
        resolveConfig: async () =>
          ({
            version: 1,
            tiers: { fast: [{ name: "fast", run: "true" }], slow: [{ name: "slow", run: "true" }] },
            when: { fast: ["pre_merge"], slow: ["pre_merge"] },
          }) as never,
        gate: async () => ({ verdict: { result: "pass", integrationBranch: integrated.localRef }, passed: true }),
        materializeReadyNode: buildCoverageAuthorityReadyNodeMaterializer(appPool),
      },
    );
    expect(verdict).toMatchObject({ result: "pass" });
    const row = await ownerPool.query<{ affected_fingerprint: string; status: string }>(
      "SELECT affected_fingerprint, status FROM integration_nodes WHERE ref = $1",
      [integrated.localRef],
    );
    expect(row.rows[0]?.status).toBe("ready");
    expect(row.rows[0]?.affected_fingerprint).toMatch(/^rv4\.coverage-authority\.v1\|/u);
    expect(diff.commands).toHaveLength(1);
  });

  it("expands rather than trusting a caller target that differs from the sealed product diff", async () => {
    const response = await analyze(primaryNodeId, "src/unknown.ts");
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      selection: {
        mode: "expanded_unknown",
        selected: [{ behaviorRevisionId: BEHAVIOR_A }, { behaviorRevisionId: BEHAVIOR_B }],
        excluded: [],
      },
    });
  });

  it("concurrent graph mutation cannot authorize omission; repeat materialization restores targeted mode", async () => {
    await ownerPool.query(
      `CREATE FUNCTION rv4_block_ready_update() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF NEW.status = 'ready' THEN PERFORM pg_advisory_xact_lock(${ADVISORY_KEY}); END IF;
         RETURN NEW;
       END $$`,
    );
    await ownerPool.query(
      `CREATE TRIGGER rv4_block_ready_update
         BEFORE UPDATE OF status ON integration_nodes
         FOR EACH ROW EXECUTE FUNCTION rv4_block_ready_update()`,
    );
    const blocker = await ownerPool.connect();
    await blocker.query("SELECT pg_advisory_lock($1)", [ADVISORY_KEY]);
    const diff = new DiffSubstrate();
    const materialize = buildCoverageAuthorityReadyNodeMaterializer(appPool);
    const input = {
      ...nodeInput("8".repeat(40), "9".repeat(40), "c".repeat(40), "d".repeat(40)),
      workspace: { ssh: diff, target, workspacePath: "/workspace/rv4-concurrent" },
    };
    const pending = materialize(input);
    try {
      await waitForAdvisoryWaiter(ownerPool);
      await runWithOrgScope(appPool, ORG, (client) =>
        BehaviorCoverageEdgesStore.record(
          client,
          { orgId: ORG, projectId: PROJECT },
          { behaviorRevisionId: BEHAVIOR_B, kind: "component", targetRef: "component-b" },
        ),
      );
    } finally {
      await blocker.query("SELECT pg_advisory_unlock($1)", [ADVISORY_KEY]);
      blocker.release();
    }
    const nodeId = await pending;

    const staleSeal = await analyze(nodeId);
    expect(staleSeal.status).toBe(201);
    await expect(staleSeal.json()).resolves.toMatchObject({
      selection: {
        mode: "expanded_unknown",
        selected: [{ behaviorRevisionId: BEHAVIOR_A }, { behaviorRevisionId: BEHAVIOR_B }],
        excluded: [],
      },
    });

    expect(await materialize(input)).toBe(nodeId);
    const refreshed = await analyze(nodeId);
    expect(refreshed.status).toBe(201);
    await expect(refreshed.json()).resolves.toMatchObject({
      selection: {
        mode: "targeted",
        selected: [{ behaviorRevisionId: BEHAVIOR_A }],
        excluded: [{ behaviorRevisionId: BEHAVIOR_B }],
      },
    });
  });
});
