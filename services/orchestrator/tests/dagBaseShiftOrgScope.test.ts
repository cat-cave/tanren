// REGRESSION (v41 finding): the LIVE base-shift seams must establish the dependent run's
// AMBIENT ORG SCOPE around their tenant accesses (the runner claim).
//
// THE BUG: the base shift runs from the walk-chain subscriber (`runWalkChain` →
// `percolate`), NOT a worker job — so there is NO ambient `runWithJobOrgId`. The live
// opener + re-gate allocate a runner, and a runner claim routes through `withJobOrgScope`
// (`PgRunnerStore.claim`), which under the enforced `tanren_app` RLS role FAILS LOUD with
// `MissingOrgScopeError` ("tenant-table access with no ambient org scope (withJobOrgScope)")
// when no scope is established. The coordinator maps that throw to `BaseShiftHeldError` →
// `base shift held at rebase`, re-driven forever — stranding EVERY dependent (each needs a
// base shift) at the first one (v41 reached only 2/11).
//
// THE FIX: the dependent run HAS an org (`ctx.orgId`, loaded by `loadBaseShiftRunContext`);
// the opener and re-gate wrap their allocation in `runWithJobOrgId(ctx.orgId, …)`, exactly as
// the worker drive path + the conflict resolver (`resolveBaseShiftConflict`) already do. So
// the runner claim's `withJobOrgScope` resolves the per-job org id and RLS admits the row.
//
// THE PROOF (seam-based, no module mocking): drive the REAL `LiveBaseShiftWorkspaceProvider`
// / `LiveBaseShiftReGate` OUTSIDE any ambient scope (the v41 condition) over (a) a faithful
// fake pool that answers `loadBaseShiftRunContext`'s reads with a known org, and (b) an
// injected fake ALLOCATOR whose `allocate()` records the ambient `getJobOrgId()` at the
// moment the runner claim would run, then throws to short-circuit before real SSH/clone. The
// recorded org must be the run's org — `undefined` is the bug (no scope) the fix closes.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { getJobOrgId } from "@tanren/db";
import type { Allocator } from "../src/engine/contracts/allocator.js";
import type { SpeculativeDependent } from "../src/engine/contracts/changePercolation.js";
import {
  LiveBaseShiftReGate,
  LiveBaseShiftWorkspaceProvider,
  type LiveBaseShiftDeps,
} from "../src/engine/dag/baseShiftLiveSeams.js";

const RUN_ORG = "org_dependent_42";
const DEP_RUN = "run_dependent_keep_me";
const DEP_SPEC = "spec_b";
const PROJECT = "project_live";

// A sentinel the allocator throws after recording the ambient scope — it short-circuits the
// real SSH/clone work; the test only cares about the org id captured at the claim boundary.
class AllocationProbeStop extends Error {
  constructor() {
    super("allocation probe stop (after recording ambient org scope)");
  }
}

// A faithful fake pool answering EXACTLY the reads `loadBaseShiftRunContext` issues:
//   1. the runs⋈specs⋈projects⋈orgs join (system scope) → the dependent run's facts + org;
//   2. `SELECT config FROM organizations` (org scope, credential resolution) → a valid
//      versioned org config carrying a static github_token (so credential resolution
//      resolves, never throws, and the seam reaches the allocation).
// BEGIN/COMMIT/SET LOCAL (the scope transaction machinery) are answered empty.
function runContextPool(): pg.Pool {
  const answer = (sql: string): { rows: unknown[]; rowCount: number } => {
    if (/FROM runs/u.test(sql) && /JOIN/u.test(sql)) {
      return {
        rows: [
          {
            org_id: RUN_ORG,
            project_id: PROJECT,
            spec_id: DEP_SPEC,
            repo_url: "https://example.test/repo.git",
            default_branch: "main",
            branch: "tanren/run_dependent",
            runner_image: "img@sha256:deadbeef",
            config: { version: 1 },
            org_config: { version: 1 },
            title: "t",
            description: "d",
            acceptance_criteria: [],
          },
        ],
        rowCount: 1,
      };
    }
    if (/FROM organizations/u.test(sql)) {
      // A valid versioned org config with a static github_token → credential resolution
      // resolves a `{ kind: "static" }` github credential (never throws before allocation).
      return {
        rows: [
          {
            config: {
              version: 1,
              defaultCredentials: {
                github_token: "secret/github/clone",
                defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/default" },
              },
            },
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: (sql: string) => Promise.resolve(answer(sql)), release: () => {} };
  return {
    query: (sql: string) => Promise.resolve(answer(sql)),
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
}

// A fake allocator whose `allocate()` records the ambient org scope at the runner-claim
// boundary, then throws to short-circuit. `release` is a no-op.
function probingAllocator(observed: { org?: string }): Allocator {
  return {
    allocate: () => {
      observed.org = getJobOrgId();
      return Promise.reject(new AllocationProbeStop());
    },
    release: () => Promise.resolve(),
  } as unknown as Allocator;
}

function deps(allocator: Allocator): LiveBaseShiftDeps {
  const pool = runContextPool();
  return {
    pool,
    allocator,
    ssh: {} as never,
    secrets: { get: () => Promise.resolve("token") } as never,
    githubHttp: {} as never,
    eventStore: {} as never,
    scopedPool: pool,
    identitySecretRef: "secret/runner/identity",
  };
}

function dependent(): SpeculativeDependent {
  return {
    specId: DEP_SPEC,
    runId: DEP_RUN,
    speculativeBase: "tanren/integ/spec_b",
    integratedAncestorShas: { spec_a: "sha-old" },
    verifiedAncestorShas: { spec_a: "sha-old" },
    lifecycleState: "building",
    openFindingMaxSeverity: "unaudited",
  } as unknown as SpeculativeDependent;
}

// Drive a seam to its allocation, swallowing ONLY the probe-stop (any other throw — e.g. a
// MissingOrgScopeError if the runner claim ran first — fails the test loudly).
async function driveToAllocation(run: () => Promise<unknown>): Promise<void> {
  await expect(run()).rejects.toBeInstanceOf(AllocationProbeStop);
}

describe("LIVE base-shift seams establish the dependent run's org scope (v41 strand-the-dependents regression)", () => {
  it("the OPENER allocates under the run's ambient org scope — NOT undefined (the no-scope bug)", async () => {
    const observed: { org?: string } = { org: "SENTINEL" };
    const opener = new LiveBaseShiftWorkspaceProvider(deps(probingAllocator(observed)));
    // The OUTSIDE-any-scope path (the walk-chain subscriber has no ambient scope) — exactly
    // the v41 condition. The non-speculative arm takes `openLiveBaseShiftWorkspace` → allocate.
    await driveToAllocation(() => opener.open({ projectId: PROJECT, dependent: dependent(), nonSpeculative: true }));
    // The allocation ran UNDER `runWithJobOrgId(ctx.orgId, …)` — the per-job org id is the
    // run's org. Before the fix this was `undefined` (no ambient scope) → the runner claim's
    // `withJobOrgScope` threw `MissingOrgScopeError` → held forever.
    expect(observed.org).toBe(RUN_ORG);
  });

  it("the OPENER's SPECULATIVE (local-assembly) arm is ALSO org-scoped", async () => {
    const observed: { org?: string } = { org: "SENTINEL" };
    const opener = new LiveBaseShiftWorkspaceProvider(deps(probingAllocator(observed)));
    await driveToAllocation(() =>
      opener.open({
        projectId: PROJECT,
        dependent: dependent(),
        nonSpeculative: false,
        ancestorStack: [{ specId: "spec_a", runId: "run_a", branch: "tanren/run_a", headSha: "sha-a-new" }],
      }),
    );
    expect(observed.org).toBe(RUN_ORG);
  });

  it("the RE-GATE allocates under the run's ambient org scope — NOT undefined", async () => {
    const observed: { org?: string } = { org: "SENTINEL" };
    const reGate = new LiveBaseShiftReGate(deps(probingAllocator(observed)));
    await driveToAllocation(() => reGate.reGate({ projectId: PROJECT, dependent: dependent(), rebasedHeadSha: "" }));
    expect(observed.org).toBe(RUN_ORG);
  });
});
