// rv-18 A2 END-TO-END proof (real Postgres + real HTTP). It drives the real
// ProofBackedWebDemo — the DEFAULT real HttpAcceptanceSurfaceDriver + real
// PgReleaseInstanceBaseUrlResolver + real PgAcceptancePlanLoader over the run's real
// `release_instances` row — as the restricted tanren_app role. It proves the whole
// proof-backed demo seam on the live substrate: the run's release → its declared
// behaviors' stored acceptance specs → a REAL HTTP probe against the live product →
// the demo verdict IS the REAL per-behavior verdict. A product whose `/health` returns
// 200 but whose declared behavior FAILS its assertion produces a FAILED demo behavior
// (failed_product), never a reachability pass. Cross-org reads see ZERO rows (RLS).
// Gated on TANREN_RLS_DB_TEST; runs in `smoke-rls-proof-backed-demo`.
import { migrate, runWithOrgScope } from "@tanren/db";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  AcceptanceOrchestrator,
  BehaviorRevisionNotFoundError,
  HttpAcceptanceSurfaceDriver,
  PgAcceptancePlanLoader,
  PgReleaseInstanceBaseUrlResolver,
} from "../src/engine/verification/acceptance/index.js";
import {
  EphemeralAcceptanceEventSink,
  EphemeralAcceptanceRunStore,
  ProofBackedWebDemo,
  buildProofBackedWebDemo,
} from "../src/engine/demo/proofBackedWebDemo.js";
import type { VerificationEnvironmentResolver } from "../src/engine/repositories/verificationEnvironments.js";
import { loadRunReleaseInstance } from "../src/engine/postMerge/demoOnDeployReads.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const APP_ROLE = "tanren_app";
const APP_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG = "org_proof_demo_rv18";
const OTHER_ORG = "org_proof_demo_rv18_other";
const PROJECT = "project_proof_demo_rv18";
const NODE_ID = "inode_proof_demo_rv18";
const PERSONA_REVISION = "pr_proof_demo_rv18";
const PASS_BR = "br_proof_demo_pass_rv18";
const FAIL_BR = "br_proof_demo_fail_rv18";
const SPEC_ID = "spec_proof_demo_rv18";
const RUN_ID = "run_proof_demo_rv18";
const D = `sha256:${"e".repeat(64)}` as Digest;
const CAS = `sha256:${"a".repeat(64)}` as Digest;

// The working behavior: the live product's /health answers 200 with count=3 (> 1).
const PASS_ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [
    { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
    { assertionId: "a2", subject: "p1.body.count", comparisonOperator: "greater_than", expected: 1 },
  ],
};
// The broken behavior: /health returns 200 (reachable) but the REAL count is 3, so
// expecting 999 must FAIL on the observed value — failed_product, never a fabricated pass.
const FAIL_ACCEPTANCE = {
  version: "v1",
  httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
  assertions: [{ assertionId: "a1", subject: "p1.body.count", comparisonOperator: "equals", expected: 999 }],
};

class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: Record<string, unknown> }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({ eventType: input.eventType, payload: input.payload as Record<string, unknown> });
  }
}

function databaseName(): string {
  return `tanren_proof_demo_rv18_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

async function seedTenant(owner: Pool, serverUrl: string): Promise<void> {
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
     VALUES ($1, $2, $3, 'main', $4, 'refs/heads/main', 'merge_batch', 'member-rv18')`,
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
  for (const [id, acceptance, num] of [
    [PASS_BR, PASS_ACCEPTANCE, 1],
    [FAIL_BR, FAIL_ACCEPTANCE, 2],
  ] as const) {
    await owner.query(
      `INSERT INTO behavior_revisions (id, org_id, project_id, behavior_id, persona_revision_id, revision_number, title, given, "when", "then", content_digest, acceptance)
       VALUES ($1, $2, $3, $4, $5, $6, 'behavior', 'g', 'w', 't', $7, $8::jsonb)`,
      [id, ORG, PROJECT, id, PERSONA_REVISION, num, D, JSON.stringify(acceptance)],
    );
  }
  // THIS run's deployed release, bound to NODE_ID, pointing at the live test server,
  // delivering BOTH declared behaviors.
  await owner.query(
    `INSERT INTO release_instances (org_id, id, project_id, provider, app_id, environment, deployment_id, source_ref, artifact_digest, integration_node_id, url, state)
     VALUES ($1, $2, $3, 'fly', 'app_proof', 'production', 'dep_run', 'refs/heads/main', $4, $5, $6, 'live')`,
    [ORG, "ri_run_rv18", PROJECT, CAS, NODE_ID, serverUrl],
  );
  for (const [ordinal, br] of [PASS_BR, FAIL_BR].entries()) {
    await owner.query(
      `INSERT INTO release_instance_behavior_revisions (org_id, release_instance_id, behavior_revision_id, ordinal)
       VALUES ($1, 'ri_run_rv18', $2, $3)`,
      [ORG, br, ordinal],
    );
  }
  // The run the persisting proof-backed demo attributes its behavior_verification_runs to
  // (run_id FK). Its spec is free-text on the run; the verdict run FKs runs(run_id).
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, $1, $1, 'in_flight')`,
    [SPEC_ID, PROJECT, ORG],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [RUN_ID, SPEC_ID, PROJECT, ORG],
  );
}

function buildDemo(events: EventStore, app: Pool): ProofBackedWebDemo {
  const orchestrator = new AcceptanceOrchestrator({
    store: new EphemeralAcceptanceRunStore(),
    events: new EphemeralAcceptanceEventSink(),
    // DEFAULT real fetch → a real HTTP probe against the live product server.
    drivers: [new HttpAcceptanceSurfaceDriver({ resolveBaseUrl: new PgReleaseInstanceBaseUrlResolver(app) })],
  });
  // This suite exercises the DRIVE logic over the ephemeral store (its release is inserted
  // directly, not via markLive), so a stub resolver suffices; the PERSISTING env-bound path
  // is proven end-to-end in deployVerificationEnvironment.rls.integration.test.ts.
  const stubResolver: VerificationEnvironmentResolver = {
    resolveForLiveRelease: (release) => Promise.resolve(release.integrationNodeId),
  };
  return new ProofBackedWebDemo({
    events,
    planLoader: new PgAcceptancePlanLoader(app),
    orchestrator,
    resolveEnvironment: stubResolver,
  });
}

describeDb("rv-18 A2 proof-backed web demo — real Pg resolver + real HTTP, end-to-end", () => {
  const database = databaseName();
  let owner: Pool;
  let app: Pool;
  let server: Server;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", count: 3 }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const admin = new Pool({ connectionString: ADMIN_URL });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: connectionUrl(database) });
    await migrate(owner);
    app = new Pool({ connectionString: connectionUrl(database, { user: APP_ROLE, password: APP_PASSWORD }) });
    await seedTenant(owner, serverUrl);
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
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

  it("runs the decisive reads as the non-superuser tanren_app role", async () => {
    const identity = await app.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles AS r WHERE r.rolname = current_user",
    );
    expect(identity.rows[0]).toEqual({ current_user: "tanren_app", rolsuper: false, rolbypassrls: false });
  });

  it("DECISIVE: the demo verdict is the REAL per-behavior verdict — /health returns 200 but the broken behavior FAILS", async () => {
    const events = new RecordingEventStore();
    const demo = buildDemo(events, app);
    const release = await loadRunReleaseInstance(app, ORG, PROJECT, NODE_ID);
    expect(release).toBeDefined();
    // The release delivers the working AND the broken behavior; the product is up (200).
    expect([...release!.behaviorRevisionIds].sort()).toEqual([FAIL_BR, PASS_BR].sort());

    const result = await demo.demo({ runId: NODE_ID, specId: "spec", projectId: PROJECT, orgId: ORG }, release!);

    // One behavior PASSES its real assertion, the other FAILS on the real observed value —
    // the demo verdict is 1 passed / 1 failed, NOT a reachability green.
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    const byId = Object.fromEntries(result.evidence.map((entry) => [entry.behaviorId, entry]));
    expect(byId[PASS_BR]!.outcome).toBe("passed");
    expect(byId[FAIL_BR]!.outcome).toBe("failed");
    expect(byId[FAIL_BR]!.detail).toContain("failed_product");
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "web_url", behaviorCount: 2, passed: 1, failed: 1 });
  });

  it("rv-env DECISIVE: the REAL proof-backed demo PERSISTS behavior verdicts FK'd to the deploy-created env", async () => {
    // The REAL production factory: PERSISTING PgAcceptanceRunStore + the real
    // PgVerificationEnvironmentResolver (NOT the ephemeral sink / fabricated env id).
    const events = new RecordingEventStore();
    const demo = buildProofBackedWebDemo(app, events, new InMemorySecretStore());
    const release = await loadRunReleaseInstance(app, ORG, PROJECT, NODE_ID);
    expect(release).toBeDefined();

    const result = await demo.demo({ runId: RUN_ID, specId: SPEC_ID, projectId: PROJECT, orgId: ORG }, release!);
    // The working behavior passes its REAL assertion; the broken one fails on the real value.
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);

    // The demo's resolver find-or-created the ready production env for THIS live release.
    const env = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{ id: string; tenant_lease_id: string }>(
        `SELECT id, tenant_lease_id FROM verification_environments
          WHERE org_id = $1 AND project_id = $2 AND integration_node_id = $3
            AND artifact_digest = $4 AND deployment_target = 'production' AND lifecycle_status = 'ready'`,
        [ORG, PROJECT, NODE_ID, CAS],
      );
      return rows.rows[0];
    });
    expect(env).toBeDefined();
    expect(env!.tenant_lease_id).toBe("ri_run_rv18");

    // Both behaviors PERSISTED a real verdict into the 0079-hardened ledger, each FK'd to the
    // deploy-created env (recordRun.environment_id) — the ephemeral sink persisted NOTHING.
    const verdicts = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{
        behavior_revision_id: string;
        outcome: string;
        req: number;
        exe: number;
        environment_id: string;
      }>(
        `SELECT v.behavior_revision_id, v.outcome, v.required_assertion_count AS req,
                v.executed_assertion_count AS exe, r.environment_id
           FROM behavior_verdicts v
           JOIN behavior_verification_runs r ON r.org_id = v.org_id AND r.id = v.run_id
          WHERE v.org_id = $1`,
        [ORG],
      );
      return rows.rows;
    });
    expect(verdicts).toHaveLength(2);
    for (const row of verdicts) expect(row.environment_id).toBe(env!.id);
    const passed = verdicts.find((row) => row.behavior_revision_id === PASS_BR);
    expect(passed!.outcome).toBe("passed");
    // The rv-11/0079 invariant STILL holds on the LIVE persisted path: a passed verdict has
    // full, non-zero coverage.
    expect(passed!.exe).toBeGreaterThanOrEqual(passed!.req);
    expect(passed!.req).toBeGreaterThanOrEqual(1);
    const failed = verdicts.find((row) => row.behavior_revision_id === FAIL_BR);
    expect(failed!.outcome).toBe("failed_product");

    // rv-9 FINDING 1: this REAL production factory now content-addresses the drive's response
    // capture and DURABLY links it onto the persisted verdict (behavior_verdict_evidence) — the
    // merge-critical demo path is no longer a dead capture path. Resolve it from the ledger alone.
    const evidence = await runWithOrgScope(app, ORG, async (client) => {
      const rows = await client.query<{ verification_artifact_id: string; cas_digest: string }>(
        `SELECT e.verification_artifact_id, e.cas_digest
           FROM behavior_verdict_evidence e
           JOIN behavior_verdicts v ON v.org_id = e.org_id AND v.id = e.verdict_id
          WHERE v.org_id = $1 AND v.behavior_revision_id = $2`,
        [ORG, PASS_BR],
      );
      return rows.rows;
    });
    expect(evidence.length).toBeGreaterThanOrEqual(1);
    expect(evidence[0]!.cas_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The linked artifact row exists (FK-guaranteed) — a real verification_artifacts capture landed.
    const artifact = await runWithOrgScope(app, ORG, (client) =>
      client.query(`SELECT 1 FROM verification_artifacts WHERE org_id = $1 AND id = $2`, [
        ORG,
        evidence[0]!.verification_artifact_id,
      ]),
    );
    expect(artifact.rowCount).toBe(1);
  });

  it("org isolation: another org sees ZERO of this org's release + behaviors (RLS denies cross-org reads)", async () => {
    // The run's release is invisible to a different org — the proof-backed demo binds
    // nothing cross-tenant.
    const foreign = await loadRunReleaseInstance(app, OTHER_ORG, PROJECT, NODE_ID);
    expect(foreign).toBeUndefined();
    // And the acceptance plan loader cannot see this org's behavior revision for another
    // org — it fails loud rather than fabricating an empty/foreign plan.
    await expect(
      new PgAcceptancePlanLoader(app).loadPlans({ orgId: OTHER_ORG, behaviorRevisionIds: [PASS_BR] }),
    ).rejects.toBeInstanceOf(BehaviorRevisionNotFoundError);
  });
});
