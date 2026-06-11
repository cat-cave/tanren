// WS-A PR-8c (walker-jj-local-integration-design.md §2.3) — on a CLEAN jj-local dependent
// bootstrap assembly, fold the assembly-captured per-ancestor head shas BACK into
// `runs.ancestor_stack[].headSha` (at enqueue the stack entries carry an EMPTY placeholder
// headSha; the assembly fills them). Percolation's DIVERGENCE KEY then reads the shas from
// `ancestor_stack` (replacing the legacy `integrated_ancestor_shas` the deleted integrator
// captured at enqueue). Two layers:
//
//   PURE / WIRING layer (always-on, runs in `just fast-check`): drive `prepareRunWorkspace`
//   with the flag ON + a non-empty stack + an injected fake `bootstrapStackHeadShaWriteBack`,
//   and pin the write-back facts — the ORDERED stack with the EMPTY enqueue placeholder
//   headSha now FILLED by the assembly-captured per-ancestor sha. Plus: a write-back FAILURE
//   never breaks the run (the divergence key is recoverable); a null-org run skips the write;
//   the legacy clone path writes nothing.
//
//   DB layer (gated behind TANREN_RLS_DB_TEST=1, like the eager_base cohort): the REAL
//   `buildBootstrapStackHeadShaWriteBack` UPDATE on the ENFORCED `tanren_app` role — the
//   head shas land org-scoped, an off-scope write touches ZERO rows, and a re-write of the
//   SAME shas is idempotent.
//
// The shared command-substrate / context / DB plumbing fixtures live in
// `helpers/jjLocalBootstrapFixtures.ts` (shared with `eagerBaseNodeBootstrap.test.ts`).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { getSystemPool, migrate, runWithOrgScope, setSystemPool } from "@tanren/db";
import { prepareRunWorkspace } from "../src/engine/workflow/plannerRunWorkspace.js";
import {
  type BootstrapStackHeadShaWriteBack,
  type BootstrapStackHeadShaWriteBackFacts,
  buildBootstrapStackHeadShaWriteBack,
} from "../src/engine/workflow/plannerRunJjLocalBootstrap.js";
import { bootstrapLocalIntegrationRef } from "../src/engine/dag/jjLocalBootstrap.js";
import type { AncestorStack } from "../src/engine/dag/ancestorStack.js";
import {
  ADMIN_URL,
  APP_PASSWORD,
  APP_ROLE,
  ASSEMBLED_HEAD,
  dbName,
  DispatchingSsh,
  makeContext,
  makeInput,
  MEMBER_SHA,
  RLS_DB_ENABLED,
  RUN_BRANCH,
  STACK,
  SYSTEM_PASSWORD,
  SYSTEM_ROLE,
  target,
  withDatabase,
  withRole,
  WORKSPACE_PATH,
} from "./helpers/jjLocalBootstrapFixtures.js";

// ===========================================================================
// PURE / WIRING layer — always-on, no DB.
// ===========================================================================

describe("bootstrap ancestor_stack head-sha write-back (wiring)", () => {
  const KEY = "WALKER_JJ_LOCAL_BASE";
  let prior: string | undefined;
  beforeEach(() => {
    prior = process.env[KEY];
    process.env[KEY] = "1";
  });
  afterEach(() => {
    if (prior === undefined) delete process.env[KEY];
    else process.env[KEY] = prior;
  });

  it("FLAG ON + clean assembly ⇒ writes the ordered stack with the ASSEMBLY-captured head shas", async () => {
    const captured: BootstrapStackHeadShaWriteBackFacts[] = [];
    const ssh = new DispatchingSsh();
    const prepared = await prepareRunWorkspace(
      makeInput(ssh, makeContext({ ancestorStack: STACK }), undefined, async (facts) => {
        captured.push(facts);
      }),
      target,
      WORKSPACE_PATH,
    );

    // The run is UNAFFECTED by the observe-only write-back — it still assembled cleanly.
    expect(prepared.cloneHeadSha).toBe(ASSEMBLED_HEAD);

    expect(captured).toHaveLength(1);
    const facts = captured[0]!;
    expect(facts.orgId).toBe("org_dep");
    expect(facts.runId).toBe("run_dep");
    // The persisted stack carries the SAME ordered members, with the EMPTY enqueue
    // placeholder headSha now FILLED by the assembly-captured per-ancestor sha.
    expect(facts.stack).toEqual([
      { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: MEMBER_SHA },
      { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: MEMBER_SHA },
    ]);
  });

  it("a write-back FAILURE NEVER breaks the run (the divergence key is recoverable)", async () => {
    const ssh = new DispatchingSsh();
    const prepared = await prepareRunWorkspace(
      makeInput(ssh, makeContext({ ancestorStack: STACK }), undefined, async () => {
        throw new Error("simulated ancestor_stack write-back failure");
      }),
      target,
      WORKSPACE_PATH,
    );
    expect(prepared.cloneHeadSha).toBe(ASSEMBLED_HEAD);
    expect(prepared.bootstrappedBaseRevision).toBe(bootstrapLocalIntegrationRef(RUN_BRANCH));
  });

  it("a null-org run SKIPS the write-back (no tenant key to scope to)", async () => {
    let called = false;
    const ssh = new DispatchingSsh();
    await prepareRunWorkspace(
      makeInput(ssh, makeContext({ ancestorStack: STACK, orgId: null }), undefined, async () => {
        called = true;
      }),
      target,
      WORKSPACE_PATH,
    );
    expect(called).toBe(false);
  });

  it("the legacy clone path (empty stack) writes NO head-sha write-back", async () => {
    let called = false;
    const ssh = new DispatchingSsh();
    await prepareRunWorkspace(
      makeInput(ssh, makeContext(), undefined, async () => {
        called = true;
      }),
      target,
      WORKSPACE_PATH,
    );
    expect(called).toBe(false);
  });
});

// ===========================================================================
// DB layer — the REAL buildBootstrapStackHeadShaWriteBack UPDATE + fail-closed RLS.
// ===========================================================================

const describeDb = RLS_DB_ENABLED ? describe : describe.skip;

const WB_ORG = "org_wb";
const WB_PROJECT = `proj_${WB_ORG}`;
const RUN_ID = "run_wb_dep";

describeDb("bootstrap ancestor_stack head-sha write-back (real DB + fail-closed RLS)", () => {
  const database = dbName("wb");
  let ownerPool: Pool;
  let appPool: Pool;
  let writeBack: BootstrapStackHeadShaWriteBack;

  // The persisted stack with the assembly-FILLED head shas (the enqueue placeholder was "").
  const FILLED_STACK: AncestorStack = [
    { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "1".repeat(40) },
    { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "2".repeat(40) },
  ];
  const FILLED_JSON = [
    { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "1".repeat(40) },
    { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "2".repeat(40) },
  ];

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    appPool = new Pool({ connectionString: withRole(ADMIN_URL, APP_ROLE, APP_PASSWORD, database) });
    setSystemPool(new Pool({ connectionString: withRole(ADMIN_URL, SYSTEM_ROLE, SYSTEM_PASSWORD, database) }));
    writeBack = buildBootstrapStackHeadShaWriteBack(appPool);

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [WB_ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, default_branch, runner_image, org_id, config)
       VALUES ($1, 'p', 'https://example.test/r', 'main', 'runner:v0', $2, '{"version":1}'::jsonb)`,
      [WB_PROJECT, WB_ORG],
    );
    // The dependent run row — enqueued with the EMPTY-placeholder stack (headSha "").
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, status, branch, ancestor_stack)
       VALUES ($1, 'spec_dep', $2, $3, 'manual', 'running', 'tanren/run_wb_dep', $4::jsonb)`,
      [
        RUN_ID,
        WB_PROJECT,
        WB_ORG,
        JSON.stringify([
          { specId: "spec-a", runId: "run-a", branch: "feat-a", headSha: "" },
          { specId: "spec-b", runId: "run-b", branch: "feat-b", headSha: "" },
        ]),
      ],
    );
  }, 60_000);

  afterAll(async () => {
    await getSystemPool()?.end();
    setSystemPool(undefined);
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

  async function readStack(): Promise<unknown> {
    return runWithOrgScope(appPool, WB_ORG, async (client) => {
      const r = await client.query<{ ancestor_stack: unknown }>("SELECT ancestor_stack FROM runs WHERE run_id = $1", [
        RUN_ID,
      ]);
      return r.rows[0]?.ancestor_stack;
    });
  }

  it("folds the head shas into runs.ancestor_stack org-scoped; off-scope updates ZERO; idempotent", async () => {
    await writeBack({ orgId: WB_ORG, runId: RUN_ID, stack: FILLED_STACK });
    expect(await readStack()).toEqual(FILLED_JSON);

    // RLS fail-closed: a write scoped to a DIFFERENT org updates ZERO rows — the real
    // run's stack is UNTOUCHED (the off-scope client sees no row).
    await writeBack({
      orgId: "org_other_wb",
      runId: RUN_ID,
      stack: [{ specId: "spec-x", runId: "run-x", branch: "feat-x", headSha: "9".repeat(40) }],
    });
    expect(await readStack()).toEqual(FILLED_JSON);

    // Re-writing the SAME shas is idempotent (the same jsonb).
    await writeBack({ orgId: WB_ORG, runId: RUN_ID, stack: FILLED_STACK });
    expect(await readStack()).toEqual(FILLED_JSON);
  });
});
