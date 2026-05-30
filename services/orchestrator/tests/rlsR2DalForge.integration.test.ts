// RLS wave R2 cohort-4 (FINAL) — the forge stores DAL conversion, proven
// against a REAL Postgres (no SQL mocks).
//
// R2 cohort-4 routes the three forge tenant tables — `forge_threads`,
// `forge_turns`, `forge_action_proposals` — through R1's org-scoped client
// (`runWithOrgScope` → `getOrgScopedClient()`), so each tenant query executes
// inside a `SET LOCAL app.current_org_id = <org>` transaction. The stores call
// `resolveWritableClient` internally (handed the pool → ambient scope when one
// is open, else the pool; handed a specific client → verbatim), and the forge
// routes + the run-detail Forge bundle open a `runWithOrgScope` scope.
// (Updated for R3b: the migration now ENABLES the policies — the org-scoped
// client returns/writes the org's rows while the raw runtime pool is denied;
// baselines compare against the OWNER pool and unscoped writes are now rejected.
// forge_turns/proposals are FK-scoped via forge_threads.) These tests prove
// that end-to-end:
//   (a) ForgeThreadStore.create/get/listForRun return the org's rows on the
//       org-scoped client, identical to the raw pool, and the in-scope write is
//       visible inside the SAME transaction (proving the ambient client was used);
//   (b) ForgeTurnStore.append/list write + read through the scope AND via the
//       pool fallback — same committed turn, audience-filtered identically;
//   (c) ForgeProposalStore.create/listForThread/claimForDecision/recordOutcome
//       carry org context inside a scope and fall back to the pool — same
//       persisted proposal + same idempotent lifecycle either way;
//   (d) app-layer org scoping holds: org A's reads never surface org B's rows.
//
// Gated behind TANREN_RLS_DB_TEST=1 + a superuser DATABASE_URL (the migration
// owner), exactly like the R1 / cohort-1/2/3 tests. Wired into `just smoke` via
// the same gate (`just smoke-rls-r2-cohort4`).

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { ForgeProposalStore } from "../src/engine/forge/proposals.js";
import { ForgeThreadStore } from "../src/engine/forge/threads.js";
import { ForgeTurnStore } from "../src/engine/forge/turns.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const RUNTIME_ROLE = "tanren_app";
const RUNTIME_PASSWORD = process.env["TANREN_APP_DB_PASSWORD"] ?? "tanren_app";

function dbName(): string {
  return `tanren_rls_r2c4_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

const ORG_A = "org_rls_a";
const ORG_B = "org_rls_b";
const PROJECT_A = `proj_${ORG_A}`;
const PROJECT_B = `proj_${ORG_B}`;
const SPEC_A = `spec_${ORG_A}`;
const RUN_A = "run_a";

// A platform-admin actor so the forge store authz (assertActorReachesScope)
// short-circuits without a project_members/users row — this cohort proves the
// DAL seam, not authz. Audience tier is platform:admin (sees every turn).
const ACTOR = {
  userId: "user_a",
  orgId: null,
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
} as const;

const RENDER = { body: "pulse", attentionItems: [], insights: [], prompts: [] } as const;

describeDb("RLS R2 cohort-4 — forge threads/turns/proposals through the org-scoped client", () => {
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

    // Two orgs; org B exists to prove the app-layer org predicate still scopes
    // reads (belt-and-suspenders) — its run-scoped thread must not surface for A.
    await seedTenant(ownerPool, ORG_A, PROJECT_A, SPEC_A, RUN_A);
    await seedTenant(ownerPool, ORG_B, PROJECT_B, `spec_${ORG_B}`, "run_b");
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

  // (a) thread create + read via the org-scoped client equal the pool, and the
  //     in-scope write is visible inside the SAME transaction.
  it("(a) thread create/get/listForRun via the org-scoped client match the pool, scoped to the org", async () => {
    // Create a run-scoped thread for org A under an org scope. The INSERT runs on
    // the ambient client; the new row is visible inside the SAME transaction.
    const created = await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const thread = await ForgeThreadStore.create(
        client,
        { orgId: ORG_A, projectId: PROJECT_A, runId: RUN_A, scope: "run", title: "a" },
        ACTOR,
      );
      const within = await client.query<{ org_id: string }>("SELECT org_id FROM forge_threads WHERE id = $1", [
        thread.id,
      ]);
      expect(within.rows[0]?.org_id).toBe(ORG_A);
      return thread;
    });
    expect(created.orgId).toBe(ORG_A);

    // get via the scope equals the OWNER (RLS-exempt) baseline; the raw pool is
    // now denied (R3b deny-by-default).
    const scoped = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ForgeThreadStore.get(client, created.id, ACTOR),
    );
    const owned = await ForgeThreadStore.get(ownerPool, created.id, ACTOR);
    expect(scoped).toEqual(owned);
    expect(scoped?.id).toBe(created.id);
    expect(await ForgeThreadStore.get(runtimePool, created.id, ACTOR)).toBeUndefined();

    // listForRun via the scope equals the OWNER baseline, and scopes to org A only.
    const scopedList = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ForgeThreadStore.listForRun(client, { orgId: ORG_A, projectId: PROJECT_A, runId: RUN_A }, ACTOR),
    );
    const ownedList = await ForgeThreadStore.listForRun(
      ownerPool,
      { orgId: ORG_A, projectId: PROJECT_A, runId: RUN_A },
      ACTOR,
    );
    expect(scopedList.map((t) => t.id)).toEqual(ownedList.map((t) => t.id));
    expect(scopedList.map((t) => t.id)).toContain(created.id);
  });

  // (b) turn append + list write/read through the scope. Under R3b the unscoped
  //     pool-fallback append is denied (forge_turns via its thread's policy).
  it("(b) turn append/list write through the scope; the pool fallback is denied", async () => {
    // The thread create itself must be scoped now (the unscoped pool is denied).
    const thread = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ForgeThreadStore.create(
        client,
        { orgId: ORG_A, projectId: PROJECT_A, runId: RUN_A, scope: "run", title: "turns" },
        ACTOR,
      ),
    );

    // Append inside a scope: the turn is visible inside the SAME transaction
    // (only if append used the ambient client for the index SELECT + INSERT).
    const scopedTurn = await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const turn = await ForgeTurnStore.append(
        client,
        {
          threadId: thread.id,
          source: { kind: "operator", userId: ACTOR.userId },
          audience: "org:admin",
          authorKind: "operator",
          render: RENDER,
        },
        ACTOR,
      );
      const within = await client.query<{ id: string }>("SELECT id FROM forge_turns WHERE thread_id = $1", [thread.id]);
      expect(within.rows.map((r) => r.id)).toContain(turn.id);
      return turn;
    });
    expect(scopedTurn.index).toBe(0);

    // Append via the raw pool (no scope) is denied: under the empty GUC the
    // parent forge_thread is invisible, so the append's index-read raises "thread
    // not found" before any INSERT — an unscoped tenant write cannot proceed.
    await expect(
      ForgeTurnStore.append(
        runtimePool,
        {
          threadId: thread.id,
          source: { kind: "operator", userId: ACTOR.userId },
          audience: "org:admin",
          authorKind: "operator",
          render: RENDER,
        },
        ACTOR,
      ),
    ).rejects.toThrow(/row-level security|policy|thread not found/iu);

    // A second scoped append advances off the committed first turn.
    const secondTurn = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ForgeTurnStore.append(
        client,
        {
          threadId: thread.id,
          source: { kind: "operator", userId: ACTOR.userId },
          audience: "org:admin",
          authorKind: "operator",
          render: RENDER,
        },
        ACTOR,
      ),
    );
    expect(secondTurn.index).toBe(1);

    // list via the scope equals the OWNER baseline — both see both committed turns.
    const scopedList = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ForgeTurnStore.list(client, { threadId: thread.id, limit: 50 }, ACTOR),
    );
    const ownedList = await ForgeTurnStore.list(ownerPool, { threadId: thread.id, limit: 50 }, ACTOR);
    expect(scopedList.map((t) => t.id)).toEqual(ownedList.map((t) => t.id));
    expect(scopedList.map((t) => t.id)).toEqual([scopedTurn.id, secondTurn.id]);
  });

  // (c) proposal create + list + claim + recordOutcome carry org context inside a
  //     scope and fall back to the pool — same persisted row + idempotent lifecycle.
  it("(c) proposal create/list/claim/recordOutcome write through the scope and via the pool fallback", async () => {
    // Setup writes must be scoped now (the unscoped pool is denied under R3b).
    const { thread, proposingTurn } = await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const t = await ForgeThreadStore.create(
        client,
        { orgId: ORG_A, projectId: PROJECT_A, runId: RUN_A, scope: "run", title: "proposals" },
        ACTOR,
      );
      const turn = await ForgeTurnStore.append(
        client,
        {
          threadId: t.id,
          source: { kind: "operator", userId: ACTOR.userId },
          audience: "org:admin",
          authorKind: "forge_llm",
          render: RENDER,
        },
        ACTOR,
      );
      return { thread: t, proposingTurn: turn };
    });
    const toolCall = { tool: "tanren.trigger_run", args: { specId: SPEC_A } } as const;

    // create inside a scope: the row is visible inside the SAME transaction.
    const created = await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const proposal = await ForgeProposalStore.create(client, {
        orgId: ORG_A,
        threadId: thread.id,
        proposingTurnId: proposingTurn.id,
        toolCall,
        rationale: "trigger the spec run",
      });
      const within = await client.query<{ org_id: string; status: string }>(
        "SELECT org_id, status FROM forge_action_proposals WHERE id = $1",
        [proposal.id],
      );
      expect(within.rows[0]).toEqual({ org_id: ORG_A, status: "pending" });
      return proposal;
    });
    expect(created.status).toBe("pending");

    // listForThread via the scope equals the OWNER baseline.
    const scopedList = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ForgeProposalStore.listForThread(client, thread.id, ACTOR),
    );
    const ownedList = await ForgeProposalStore.listForThread(ownerPool, thread.id, ACTOR);
    expect(scopedList.map((p) => p.id)).toEqual(ownedList.map((p) => p.id));
    expect(scopedList.map((p) => p.id)).toContain(created.id);

    // claim + recordOutcome through the scope drive the full lifecycle; a second
    // claim is rejected (idempotency), and the committed terminal state is the
    // same whether re-read inside the scope or on a fresh pool connection.
    await runWithOrgScope(runtimePool, ORG_A, async (client) => {
      const claimed = await ForgeProposalStore.claimForDecision(client, created.id, "approved", ACTOR);
      expect(claimed.status).toBe("approved");
      const outcome = await ForgeProposalStore.recordOutcome(client, created.id, {
        status: "executed",
        result: { ok: true },
      });
      expect(outcome.status).toBe("executed");
    });

    // Committed terminal state via the OWNER pool (RLS-exempt ground truth).
    const committed = await ForgeProposalStore.get(ownerPool, created.id, ACTOR);
    expect(committed?.status).toBe("executed");
    expect(committed?.result).toEqual({ ok: true });

    // A scoped claim on the already-decided proposal is idempotently rejected.
    await expect(
      runWithOrgScope(runtimePool, ORG_A, (client) =>
        ForgeProposalStore.claimForDecision(client, created.id, "rejected", ACTOR),
      ),
    ).rejects.toThrow(/already decided/u);
  });

  // (d) app-layer org scoping: org A's run-thread list never surfaces org B's
  //     thread, even though both share the run-scoped query shape.
  it("(d) org A's thread/turn reads never surface org B's rows", async () => {
    // Create org B's thread under org B's scope (the unscoped pool is denied).
    const threadB = await runWithOrgScope(runtimePool, ORG_B, (client) =>
      ForgeThreadStore.create(
        client,
        { orgId: ORG_B, projectId: PROJECT_B, runId: "run_b", scope: "run", title: "b" },
        ACTOR,
      ),
    );
    const listA = await runWithOrgScope(runtimePool, ORG_A, (client) =>
      ForgeThreadStore.listForRun(client, { orgId: ORG_A, projectId: PROJECT_A, runId: RUN_A }, ACTOR),
    );
    expect(listA.map((t) => t.id)).not.toContain(threadB.id);
    expect(listA.every((t) => t.orgId === ORG_A)).toBe(true);
  });
});

// Seed an org + project + spec + run for a tenant, as the owner pool. Mirrors the
// cohort-1/2/3 tests' seeder; kept local so the cohorts stay independent.
async function seedTenant(owner: Pool, orgId: string, projectId: string, specId: string, runId: string): Promise<void> {
  await owner.query(
    `INSERT INTO organizations (id, kind, external_id, login, display_name)
     VALUES ($1, 'oidc', $1, $1, $1)`,
    [orgId],
  );
  await owner.query(
    `INSERT INTO projects (project_id, name, repo_url, org_id)
     VALUES ($1, 'p', 'https://example.com/r.git', $2)`,
    [projectId, orgId],
  );
  await owner.query(
    `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
     VALUES ($1, $2, $3, 't', 'd', 'pending')`,
    [specId, projectId, orgId],
  );
  await owner.query(
    `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
     VALUES ($1, $2, $3, $4, 'cli', 'main', 'running')`,
    [runId, specId, projectId, orgId],
  );
}
