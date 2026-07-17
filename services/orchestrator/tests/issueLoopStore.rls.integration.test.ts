// bh-1 — the IssueLoop aggregate store proven against a REAL Postgres (no SQL
// mocks), like the design-contracts / benchmark-entities DAL tests. Proves:
//   (POSITIVE) create an issue loop + append immutable findings, read both back
//     under the owning org scope; findings come back append-ordered.
//   (NEGATIVE — cross-org RLS) org B sees ZERO of org A's loops/findings, and an
//     UNSCOPED runtime-pool read (empty GUC) sees ZERO rows — deny-by-default.
//   (NEGATIVE — write scope) org A cannot INSERT a loop owned by org B (WITH CHECK).
//   (NEGATIVE — immutability) UPDATE and DELETE of an existing source finding are
//     rejected by the migration-0049 append-only trigger.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the other RLS integration smokes. Run it with:
//   just smoke-rls-issue-loop

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { IssueLoopStore } from "../src/engine/repositories/issueLoops.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_issue_loop_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
function runtimeUrl(adminUrl: string, database: string): string {
  const parsed = new URL(adminUrl);
  parsed.username = RUNTIME_ROLE;
  parsed.password = RUNTIME_PASSWORD;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG_A = "org_loop_a";
const ORG_B = "org_loop_b";
const PROJECT_A = "project_loop_a";
const PROJECT_B = "project_loop_b";
const SOURCE_A = "src_loop_a";
const SOURCE_B = "src_loop_b";

describeDb("issue_loops / source_findings DAL — immutable, org-scoped", () => {
  const database = dbName();
  let ownerPool: Pool;
  let runtimePool: Pool;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({ connectionString: runtimeUrl(ADMIN_URL, database) });
    setSystemPool(undefined);

    for (const org of [ORG_A, ORG_B]) {
      await ownerPool.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [org],
      );
    }
    for (const [project, org] of [
      [PROJECT_A, ORG_A],
      [PROJECT_B, ORG_B],
    ]) {
      await ownerPool.query(
        `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
         VALUES ($1, 'p', 'https://github.com/cat-cave/fixture', 'main', 'runner:v0', $2, '{}'::jsonb)`,
        [project, org],
      );
    }
    for (const [source, org, project] of [
      [SOURCE_A, ORG_A, PROJECT_A],
      [SOURCE_B, ORG_B, PROJECT_B],
    ]) {
      await ownerPool.query(
        `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
         VALUES ($1, $2, $3, 'issues', 'src')`,
        [source, org, project],
      );
    }
  }, 60_000);

  afterAll(async () => {
    await runtimePool?.end();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("(POSITIVE) creates a loop + appends immutable findings, read back under the owning org scope", async () => {
    const loop = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.create(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        sourceId: SOURCE_A,
        externalKey: "issue-42",
        fingerprint: "fp-42",
        severity: "high",
      }),
    );
    expect(loop.orgId).toBe(ORG_A);
    expect(loop.state).toBe("open");
    expect(loop.generation).toBe(1);
    expect(loop.rowVersion).toBe(1);
    expect(loop.resolutionPolicy).toBe("active_causal");

    const first = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.appendFinding(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        issueLoopId: loop.id,
        sourceId: SOURCE_A,
        providerObjectId: "gh-42",
        providerRevision: "rev-1",
        status: "open",
        title: "checkout CTA clipped",
        fingerprint: "fp-42",
        observedAt: new Date("2026-07-16T00:00:00.000Z"),
        context: { viewport: "375x812" },
      }),
    );
    expect(first.providerRevision).toBe("rev-1");
    expect(first.context).toEqual({ viewport: "375x812" });

    // A new provider revision is a NEW append, never an overwrite.
    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.appendFinding(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        issueLoopId: loop.id,
        sourceId: SOURCE_A,
        providerObjectId: "gh-42",
        providerRevision: "rev-2",
        status: "edited",
        title: "checkout CTA clipped (edited)",
        fingerprint: "fp-42",
        observedAt: new Date("2026-07-16T01:00:00.000Z"),
      }),
    );

    const findings = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.listFindings(client, ORG_A, loop.id),
    );
    expect(findings.map((f) => f.providerRevision)).toEqual(["rev-1", "rev-2"]);

    const loops = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.listForProject(client, ORG_A, PROJECT_A),
    );
    expect(loops.map((l) => l.id)).toContain(loop.id);
  });

  it("(NEGATIVE) org B sees ZERO of org A's loops/findings; an unscoped read sees ZERO rows", async () => {
    const loopA = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.create(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        sourceId: SOURCE_A,
        externalKey: "issue-cross",
        fingerprint: "fp-cross",
        severity: "critical",
      }),
    );
    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.appendFinding(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        issueLoopId: loopA.id,
        sourceId: SOURCE_A,
        providerObjectId: "gh-cross",
        providerRevision: "rev-1",
        status: "open",
        title: "secret",
        fingerprint: "fp-cross",
        observedAt: new Date("2026-07-16T02:00:00.000Z"),
      }),
    );

    // Org B cannot read org A's loop by id (deny-by-default).
    const crossGet = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      IssueLoopStore.get(client, ORG_A, PROJECT_A, loopA.id),
    );
    expect(crossGet).toBeUndefined();

    // Org B's project listing never includes org A's loops.
    const crossList = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      IssueLoopStore.listForProject(client, ORG_A, PROJECT_A),
    );
    expect(crossList).toEqual([]);

    // Org B cannot read org A's findings.
    const crossFindings = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      IssueLoopStore.listFindings(client, ORG_A, loopA.id),
    );
    expect(crossFindings).toEqual([]);

    // An UNSCOPED runtime-pool read (empty GUC) sees ZERO rows — every row denied.
    const unscoped = await IssueLoopStore.listForProject(runtimePool, ORG_A, PROJECT_A);
    expect(unscoped).toEqual([]);
  });

  it("(NEGATIVE) org A cannot INSERT a loop owned by org B (RLS WITH CHECK)", async () => {
    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        IssueLoopStore.create(client, {
          orgId: ORG_B,
          projectId: PROJECT_B,
          sourceId: SOURCE_B,
          externalKey: "spoof",
          fingerprint: "fp-spoof",
          severity: "low",
        }),
      ),
    ).rejects.toThrow(/row-level security|violates|new row/iu);
  });

  it("(NEGATIVE) an existing source finding cannot be UPDATEd or DELETEd (append-only trigger)", async () => {
    const loop = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.create(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        sourceId: SOURCE_A,
        externalKey: "issue-immutable",
        fingerprint: "fp-immutable",
        severity: "medium",
      }),
    );
    const finding = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.appendFinding(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        issueLoopId: loop.id,
        sourceId: SOURCE_A,
        providerObjectId: "gh-immutable",
        providerRevision: "rev-1",
        status: "open",
        title: "immutable",
        fingerprint: "fp-immutable",
        observedAt: new Date("2026-07-16T03:00:00.000Z"),
      }),
    );

    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        client.query(`UPDATE source_findings SET title = 'tampered' WHERE org_id = $1 AND id = $2`, [
          ORG_A,
          finding.id,
        ]),
      ),
    ).rejects.toThrow(/immutable|append-only/iu);

    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        client.query(`DELETE FROM source_findings WHERE org_id = $1 AND id = $2`, [ORG_A, finding.id]),
      ),
    ).rejects.toThrow(/immutable|append-only/iu);

    // The row survives both rejected mutations, unchanged.
    const findings = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.listFindings(client, ORG_A, loop.id),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe("immutable");
  });
});
