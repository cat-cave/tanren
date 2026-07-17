// MQ-5: real Postgres restricted-role proof for atomic multi-member land groups.

import { migrate, runWithOrgScope } from "@tanren/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDigest } from "../src/engine/contracts/cas.js";
import type { LandBindingEnvelope } from "../src/engine/contracts/mergeAuthority.js";
import type { RunStateWriter } from "../src/engine/contracts/runStateWriter.js";
import { PgLandGroupStore, type LandGroupMemberContext } from "../src/engine/merge/landGroupStore.js";
import { MergeAuthorityV2Impl, SubjectEqualityRevalidator } from "../src/engine/merge/mergeAuthorityV2Impl.js";
import { LandCasRejectedError } from "../src/engine/providers/githubCodeHost.js";
import type { LandAuthorizedIntegrationInput } from "../src/engine/contracts/codeHost.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { InMemoryCodeHost } from "./conformance/fakes/inMemoryCodeHost.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;
const adminUrl = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const appPassword = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";
const ORG_A = "org_land_group_a";
const ORG_B = "org_land_group_b";
const PROJECT_A = "project_land_group_a";

class RaceThenLandHost extends InMemoryCodeHost {
  readonly inputs: LandAuthorizedIntegrationInput[] = [];
  private raced = false;

  override async landAuthorizedIntegration(
    input: LandAuthorizedIntegrationInput,
  ): ReturnType<InMemoryCodeHost["landAuthorizedIntegration"]> {
    this.inputs.push(input);
    if (!this.raced) {
      this.raced = true;
      await this.pushRef({ repo: input.repo, localRef: "main-raced", remoteBranch: input.intoMain, sha: "main-moved" });
      throw new LandCasRejectedError(input.intoMain, input.expectedMainSha, "main-moved");
    }
    return super.landAuthorizedIntegration(input);
  }
}

function databaseName(): string {
  return `tanren_land_groups_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function databaseUrl(url: string, database: string, app = false): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  if (app) {
    parsed.username = "tanren_app";
    parsed.password = appPassword;
  }
  return parsed.toString();
}

function members(projectId: string): LandGroupMemberContext[] {
  return [
    {
      specId: "spec_land_a",
      runId: "run_land_a",
      branch: "feature/a",
      headSha: "member-a",
      prNumber: 41,
      prUrl: "https://example.test/pulls/41",
      projectId,
      taskId: "task_land_a",
    },
    {
      specId: "spec_land_b",
      runId: "run_land_b",
      branch: "feature/b",
      headSha: "member-b",
      prNumber: 42,
      prUrl: "https://example.test/pulls/42",
      projectId,
      taskId: "task_land_b",
    },
  ];
}

function envelope(input: { nodeId: string; expectedMainSha: string; authorizedSha: string }): LandBindingEnvelope {
  return {
    subject: { kind: "integration_node", id: input.nodeId },
    members: members(PROJECT_A).map((member) => ({ ...member, disposition: "admit" })),
    headSha: input.authorizedSha,
    expectedMainSha: input.expectedMainSha,
    artifactDigest: parseDigest(`sha256:${"a".repeat(64)}`),
    proofRoot: parseDigest(`sha256:${"b".repeat(64)}`),
    memberSetHash: `member-set-${input.nodeId}`,
    policyVersion: "1",
    target: { repo: { owner: "tanren", name: "land-groups" }, intoMain: "main" },
  };
}

function cleanInput(value: LandBindingEnvelope) {
  return {
    subject: value.subject,
    gateVerdict: "passed" as const,
    findings: [],
    auditPosture: { blockReviewAt: "P1" as const, p2p3Handling: "route-to-dag" as const },
    reviewVerdict: "approved" as const,
    mergeability: "clean" as const,
    budget: { kind: "not_required" as const },
    demo: "not_required" as const,
    hitlSignoff: "not_required" as const,
    conflicts: "resolved" as const,
  };
}

describeDb("land groups — real PG and enforced tanren_app RLS", () => {
  const database = databaseName();
  const repo = { owner: "tanren", name: "land-groups" };
  let owner: Pool;
  let runtime: Pool;
  let writer: RunStateWriter;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(`CREATE DATABASE ${database}`);
    await admin.end();
    owner = new Pool({ connectionString: databaseUrl(adminUrl, database) });
    await migrate(owner);
    runtime = new Pool({ connectionString: databaseUrl(adminUrl, database, true) });
    writer = new DirectRunStateWriter(runtime);
    await seed(owner, ORG_A, PROJECT_A);
    await seed(owner, ORG_B, "project_land_group_b");
  }, 60_000);

  afterAll(async () => {
    await runtime?.end();
    await owner?.end();
    const admin = new Pool({ connectionString: adminUrl });
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }, 30_000);

  it("forms two-member groups, re-derives after a CAS race, and reconciles the retry exactly once", async () => {
    const host = new RaceThenLandHost();
    host.seed(repo, "main", "main-before");
    const first = envelope({
      nodeId: "node-before",
      expectedMainSha: "main-before",
      authorizedSha: "authorized-before",
    });
    const firstAuthority = authorityFor(runtime, writer, "group-before", host);
    const firstAuth = await firstAuthority.authorizeLand(cleanInput(first), first);
    await expect(firstAuthority.land(firstAuth)).rejects.toBeInstanceOf(LandCasRejectedError);

    // A changed main SHA is progress: the next coordinator pass derives a new exact
    // integration/decision against it. There is no retry cap; this test drives one
    // such progression and then replays the completed reconcile token.
    const retry = envelope({ nodeId: "node-after", expectedMainSha: "main-moved", authorizedSha: "authorized-after" });
    const retryAuthority = authorityFor(runtime, writer, "group-after", host);
    const retryAuth = await retryAuthority.authorizeLand(cleanInput(retry), retry);
    await expect(retryAuthority.land(retryAuth)).resolves.toEqual({
      kind: "landed",
      mainSha: "authorized-after",
      auditId: "run_land_b",
    });
    await expect(retryAuthority.land(retryAuth)).resolves.toMatchObject({
      kind: "landed",
      mainSha: "authorized-after",
    });

    expect(host.inputs).toHaveLength(2);
    await runWithOrgScope(runtime, ORG_A, async (client) => {
      const role = await client.query<{ current_user: string }>("SELECT current_user");
      expect(role.rows[0]?.current_user).toBe("tanren_app");
      const groups = await client.query<{ id: string; state: string; main_sha: string | null }>(
        "SELECT id, state, main_sha FROM land_groups ORDER BY id",
      );
      expect(groups.rows).toEqual([
        { id: "group-after", state: "completed", main_sha: "authorized-after" },
        { id: "group-before", state: "formed", main_sha: null },
      ]);
      const landed = await client.query<{ outcome: string }>(
        "SELECT outcome FROM land_group_members WHERE land_group_id = 'group-after' ORDER BY member_key",
      );
      expect(landed.rows).toEqual([{ outcome: "landed" }, { outcome: "landed" }]);
      const specs = await client.query<{ status: string }>(
        "SELECT status FROM specs WHERE spec_id IN ('spec_land_a', 'spec_land_b') ORDER BY spec_id",
      );
      expect(specs.rows).toEqual([{ status: "merged" }, { status: "merged" }]);
      const events = await client.query<{ event_type: string }>(
        `SELECT event_type FROM events
          WHERE event_type IN ('merge.group.formed', 'merge.land_group.completed') ORDER BY id`,
      );
      expect(events.rows.map((row) => row.event_type)).toEqual([
        "merge.group.formed",
        "merge.group.formed",
        "merge.land_group.completed",
      ]);
    });
  });

  it("keeps all durable group rows invisible across orgs and without an RLS scope", async () => {
    await runWithOrgScope(runtime, ORG_B, async (client) => {
      const groups = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM land_groups");
      const scopedMembers = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM land_group_members",
      );
      expect(groups.rows[0]?.count).toBe("0");
      expect(scopedMembers.rows[0]?.count).toBe("0");
    });
    const groups = await runtime.query<{ count: string }>("SELECT count(*)::text AS count FROM land_groups");
    const allMembers = await runtime.query<{ count: string }>("SELECT count(*)::text AS count FROM land_group_members");
    expect(groups.rows[0]?.count).toBe("0");
    expect(allMembers.rows[0]?.count).toBe("0");
  });
});

function authorityFor(
  pool: Pool,
  writer: RunStateWriter,
  groupId: string,
  host: RaceThenLandHost,
): MergeAuthorityV2Impl {
  return new MergeAuthorityV2Impl(
    host,
    new SubjectEqualityRevalidator(),
    new PgLandGroupStore({
      pool,
      writer,
      orgId: ORG_A,
      projectId: PROJECT_A,
      groupId,
      partitionId: "partition-land",
      policyVersion: 1,
      members: members(PROJECT_A),
    }),
  );
}

async function seed(pool: Pool, orgId: string, projectId: string): Promise<void> {
  await pool.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
     VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
    [orgId],
  );
  await pool.query("INSERT INTO projects (project_id, name, repo_url, org_id) VALUES ($1, $1, $2, $3)", [
    projectId,
    `https://example.test/${projectId}.git`,
    orgId,
  ]);
  if (orgId !== ORG_A) return;
  for (const member of members(projectId)) {
    await pool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1,$2,$3,$1,$1,'in_flight')`,
      [member.specId, projectId, orgId],
    );
    await pool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1,$2,$3,$4,'cli',$5,'running')`,
      [member.runId, member.specId, projectId, orgId, member.branch],
    );
    await pool.query(
      `INSERT INTO tasks (task_id, run_id, org_id, kind, title, status, agent_kind, cli)
       VALUES ($1,$2,$3,'merge',$1,'running','system','system')`,
      [member.taskId, member.runId, orgId],
    );
  }
}
