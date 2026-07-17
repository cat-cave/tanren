// bh-2 — the triage-to-fix path is a tenant-scoped, queryable graph:
//   issue_loop → source_finding → real issue-loop task → spec origin → spec.
// This runs against a fresh migrated database as tanren_app; ownerPool is used
// only for provisioning the database and immutable test fixtures.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { CostRecorder } from "../src/engine/costs/recorder.js";
import type { EventStore } from "../src/engine/eventStore.js";
import { IssueLoopStore } from "../src/engine/repositories/issueLoops.js";
import { SpecOriginStore } from "../src/engine/repositories/specOrigins.js";
import { emptyTokenUsage } from "../src/engine/providers/types.js";
import { insertChildTask } from "../src/engine/workflow/subtaskTasks.js";
import {
  buildTriageNewSpecsMaterializer,
  findSpecOriginByKey,
  triageMaterializerSystemActor,
} from "../src/engine/workflow/plannerRunTriageNewSpecs.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_origin_a";
const ORG_B = "org_origin_b";
const PROJECT_A = "project_origin_a";
const PROJECT_B = "project_origin_b";
const SOURCE_A = "source_origin_a";
const SOURCE_B = "source_origin_b";
const PARENT_SPEC = "spec_origin_parent_a";
const TRIAGE_TASK = "task_origin_triage_a";

function dbName(): string {
  return `tanren_spec_origins_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function databaseUrl(url: string, database: string, role?: string, password?: string): string {
  const parsed = new URL(url);
  if (role !== undefined) parsed.username = role;
  if (password !== undefined) parsed.password = password;
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

describeDb("spec origins / triage task scope — RLS integration", () => {
  const database = dbName();
  let ownerPool!: Pool;
  let runtimePool!: Pool;
  let originLoopId: string | undefined;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: databaseUrl(ADMIN_URL, database) });
    await migrate(ownerPool);
    runtimePool = new Pool({
      connectionString: databaseUrl(ADMIN_URL, database, RUNTIME_ROLE, RUNTIME_PASSWORD),
    });
    setSystemPool(undefined);

    for (const [org, project, source] of [
      [ORG_A, PROJECT_A, SOURCE_A],
      [ORG_B, PROJECT_B, SOURCE_B],
    ]) {
      await ownerPool.query(
        `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
         VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
        [org],
      );
      await ownerPool.query(
        `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
         VALUES ($1, 'origin test', 'https://github.com/tanren/fixture', 'main', 'runner:v0', $2, '{}'::jsonb)`,
        [project, org],
      );
      await ownerPool.query(
        `INSERT INTO inbox_sources (id, org_id, project_id, kind, name)
         VALUES ($1, $2, $3, 'issues', 'origin test source')`,
        [source, org, project],
      );
    }
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description)
       VALUES ($1, $2, $3, 'parent', 'parent spec')`,
      [PARENT_SPEC, PROJECT_A, ORG_A],
    );
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

  it("records the issue-loop task, spec origin, source findings, and issue-loop cost", async () => {
    const currentUser = await runtimePool.query<{ current_user: string }>("SELECT current_user");
    expect(currentUser.rows[0]?.current_user).toBe(RUNTIME_ROLE);

    const loop = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.create(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        sourceId: SOURCE_A,
        externalKey: "issue-origin-1",
        fingerprint: "fingerprint-origin-1",
        severity: "high",
      }),
    );
    originLoopId = loop.id;
    const finding = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      IssueLoopStore.appendFinding(client, {
        orgId: ORG_A,
        projectId: PROJECT_A,
        issueLoopId: loop.id,
        sourceId: SOURCE_A,
        providerObjectId: "github-origin-1",
        providerRevision: "rev-1",
        status: "open",
        title: "checkout failure",
        fingerprint: "fingerprint-origin-1",
        observedAt: new Date("2026-07-17T00:00:00.000Z"),
      }),
    );

    await runWithOrgScope(runtimePool, ORG_A, (client) =>
      insertChildTask(client, {
        taskId: TRIAGE_TASK,
        issueLoopId: loop.id,
        orgId: ORG_A,
        kind: "triage",
        title: "triage checkout failure",
        agentKind: "answerer",
        cli: "fake",
        model: "fake",
      }),
    );

    const materialize = buildTriageNewSpecsMaterializer({
      pool: runtimePool,
      resolveActor: triageMaterializerSystemActor,
    });
    await materialize({
      runId: "run_origin_a",
      parentSpecId: PARENT_SPEC,
      projectId: PROJECT_A,
      orgId: ORG_A,
      issueLoopId: loop.id,
      newSpecs: [
        {
          id: "routed-origin-1",
          title: "fix checkout failure",
          body: "Restore checkout after the provider failure.",
          findingIds: [finding.id],
          originTriageTaskId: TRIAGE_TASK,
        },
      ],
    });

    const origin = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      SpecOriginStore.listByIssueLoop(client, ORG_A, PROJECT_A, loop.id),
    );
    expect(origin).toHaveLength(1);
    expect(origin[0]).toMatchObject({
      orgId: ORG_A,
      projectId: PROJECT_A,
      issueLoopId: loop.id,
      triageTaskId: TRIAGE_TASK,
      attemptNumber: 1,
      role: "primary_fix",
      ordinal: 0,
      sourceFindingIds: [finding.id],
    });
    const originId = origin[0]!.id;

    const queriedOrigin = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      SpecOriginStore.get(client, ORG_A, PROJECT_A, originId),
    );
    expect(queriedOrigin?.specId).toBe(origin[0]!.specId);
    const keySpecId = await findSpecOriginByKey(runtimePool, {
      orgId: ORG_A,
      projectId: PROJECT_A,
      issueLoopId: loop.id,
      attemptNumber: 1,
      ordinal: 0,
    });
    expect(keySpecId).toBe(origin[0]!.specId);

    const facts = await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const spec = await client.query<{ origin_issue_loop_id: string | null }>(
        "SELECT origin_issue_loop_id FROM specs WHERE spec_id = $1",
        [origin[0]!.specId],
      );
      const task = await client.query<{ run_id: string | null; issue_loop_id: string | null }>(
        "SELECT run_id, issue_loop_id FROM tasks WHERE task_id = $1",
        [TRIAGE_TASK],
      );
      const eventStore: EventStore = { append: async () => {} };
      await new CostRecorder(runtimePool, eventStore).record(
        {
          runId: "run_origin_a",
          issueLoopId: loop.id,
          taskId: TRIAGE_TASK,
          specId: origin[0]!.specId,
          projectId: PROJECT_A,
          orgId: ORG_A,
          cli: "fake",
          model: "fake",
          authRef: "credential/fake",
        },
        emptyTokenUsage,
        {},
      );
      const cost = await client.query<{ run_id: string | null; issue_loop_id: string | null }>(
        "SELECT run_id, issue_loop_id FROM cost_records WHERE task_id = $1",
        [TRIAGE_TASK],
      );
      return { spec: spec.rows[0], task: task.rows[0], cost: cost.rows[0] };
    });
    expect(facts.spec?.origin_issue_loop_id).toBe(loop.id);
    expect(facts.task).toEqual({ run_id: null, issue_loop_id: loop.id });
    expect(facts.cost).toEqual({ run_id: null, issue_loop_id: loop.id });
  });

  it("does not expose provenance across org scopes or without a scope", async () => {
    expect(originLoopId).toBeDefined();
    const crossOrg = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      SpecOriginStore.listByIssueLoop(client, ORG_A, PROJECT_A, originLoopId!),
    );
    expect(crossOrg).toEqual([]);
    const unscoped = await SpecOriginStore.listByIssueLoop(runtimePool, ORG_A, PROJECT_A, originLoopId!);
    expect(unscoped).toEqual([]);
  });
});
