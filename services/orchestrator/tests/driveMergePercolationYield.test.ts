// Percolation MUTUAL-EXCLUSION at the merge-drive level (engine/merge/coordinatorBuild.ts
// + driveConflictResolve.ts). When the drive pass hits a real conflict but
// change-percolation already OWNS the spec (a live `runs.percolation_pending` marker —
// the same read plannerRunAdapters uses), the drive-path conflict resolver YIELDS
// (throws PercolationOwnsSpecError) rather than racing percolation's own re-exec +
// conflict route. `buildDriveMerge` catches it and returns a RECOVERABLE `blocked`
// hold — NEVER the `needs_attention` escalation and NEVER a re-exec. This proves the
// guard end-to-end through the real merge dispatcher's conflict path.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { buildDriveMerge } from "../src/engine/merge/coordinatorBuild.js";
import { FakeAllocator } from "../src/engine/contracts/allocator.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeCommandSubstrate } from "../src/engine/contracts/commandSubstrate.js";
import { inertGitHubHttp } from "./helpers/githubHttp.js";

const RUN_ID = "run_yield";
const SPEC_ID = "spec_yield";
const PROJECT_ID = "project_yield";
const ORG_ID = "org_yield";
// An arbitrary PR number for the run's PR URL. The CONFLICT here is forced via the
// injected `baseShiftRebaseOverride` (jj owns conflict), not a fake mergeability read —
// so the drive's conflict-resolver hook (where the percolation-yield lives) is reached.
const PR_URL = "https://github.com/acme/widget/pull/9";

const CONTROL = /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|NOTIFY)/u;
const EVENTS_INSERT_PREFIX = `INSERT INTO ${["events"].join("")}`;

/**
 * A native_queue project config so the drive runs the directMerge logic (P2a/P2b)
 * and a real conflict (dirty PR) reaches the conflict-resolver hook.
 */
function projectConfig(): unknown {
  return {
    version: 1,
    mergeIntegration: "native_queue",
    governancePosture: "open",
    reviewPolicy: "auto",
    credentials: {
      githubCredentialRef: "credential/github/dev",
      defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" },
    },
  };
}

/** The fake pool: answers the drive's tenant reads + the conflict hook's percolation read (marker set). */
function fakePool(): pg.Pool {
  const answer = (sql: string): { rows: unknown[]; rowCount: number } => {
    const text = sql.trim();
    if (CONTROL.test(text)) return { rows: [], rowCount: 0 };
    // resolveRunFacts: runs ⋈ projects.
    if (/SELECT r\.org_id, r\.project_id, r\.spec_id, p\.config/u.test(sql)) {
      return {
        rows: [{ org_id: ORG_ID, project_id: PROJECT_ID, spec_id: SPEC_ID, config: projectConfig() }],
        rowCount: 1,
      };
    }
    // resolveCredentialsForRun: org provider-mode read.
    if (/SELECT config FROM organizations WHERE id/u.test(sql))
      return { rows: [{ config: { version: 1 } }], rowCount: 1 };
    // loadReviewMergeRunContext: the merge-stage run context join.
    if (/FROM runs r/u.test(sql) && /default_branch/u.test(sql)) {
      return {
        rows: [
          {
            run_id: RUN_ID,
            spec_id: SPEC_ID,
            project_id: PROJECT_ID,
            pr_url: PR_URL,
            config: projectConfig(),
            default_branch: "main",
            org_config: null,
          },
        ],
        rowCount: 1,
      };
    }
    // resolveSpeculativeState: not speculative (empty ancestor_stack).
    if (/SELECT ancestor_stack, spec_id, project_id FROM runs/u.test(sql)) {
      return { rows: [{ ancestor_stack: null, spec_id: SPEC_ID, project_id: PROJECT_ID }], rowCount: 1 };
    }
    if (/SELECT depends_on FROM specs/u.test(sql)) return { rows: [{ depends_on: [] }], rowCount: 1 };
    // ensureMergeTask.
    if (/FROM tasks/u.test(sql) && /LIMIT 1/u.test(sql)) return { rows: [], rowCount: 0 };
    if (text.startsWith("INSERT INTO tasks")) return { rows: [], rowCount: 1 };
    if (text.startsWith("UPDATE tasks SET status")) return { rows: [], rowCount: 1 };
    // The conflict hook's PERCOLATION read — a LIVE marker means percolation owns the spec.
    if (/SELECT percolation_pending FROM runs/u.test(sql)) {
      return { rows: [{ percolation_pending: { ancestorSpecId: "spec_anc", toSha: "deadbeef" } }], rowCount: 1 };
    }
    // §5 cutover: the drive's land-signal reads (the recorded pre_merge gate verdict +
    // the review verdict). This drive YIELDS to percolation before any land, so these
    // return empty (no recorded verdict) and never gate a merge here.
    if (/FROM events/u.test(sql) && /gate\.verdict/u.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM events/u.test(sql) && /review\.approved/u.test(sql)) return { rows: [], rowCount: 0 };
    if (text.startsWith(EVENTS_INSERT_PREFIX)) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL in percolation-yield fake: ${text}`);
  };
  const client = { query: (sql: string) => Promise.resolve(answer(sql)), release: () => {} };
  return {
    query: (sql: string) => Promise.resolve(answer(sql)),
    connect: () => Promise.resolve(client),
  } as unknown as pg.Pool;
}

describe("buildDriveMerge — percolation mutual exclusion (the drive YIELDS, never escalates)", () => {
  it("a live percolation_pending marker on a conflicting drive → recoverable `blocked` hold, NOT needs_attention", async () => {
    const allocator = new SpyAllocator();
    const drive = buildDriveMerge({
      pool: fakePool(),
      secrets: new FakeSecretStore(),
      githubHttp: inertGitHubHttp(),
      allocator,
      ssh: new FakeCommandSubstrate(),
      identitySecretRef: "secret/runner/identity",
      // §5h: freshness is the `CodeHost`-derived ancestry signal — inject a `behind` probe +
      // a base-shift hook that surfaces the CONFLICT (jj owns conflict), so the conflict
      // reaches the drive's resolver hook (where the percolation-yield lives) without a real
      // GitHub provider / a real jj rebase.
      mergeProbe: {
        readFreshness: async () => ({ state: "behind", behind: true, baseBranch: "main", headBranch: "tanren/run_1" }),
        readBaseBranch: async () => "main",
        retargetBase: async () => {},
      },
      baseShiftRebaseOverride: async () => ({ outcome: "conflict", message: "branch conflicts with base" }),
    });

    const outcome = await drive({ runId: RUN_ID, projectId: PROJECT_ID });

    // YIELD: a recoverable hold (the subscriber re-drives later) — NEVER the
    // `needs_attention` terminal escalation, and NEVER a re-exec.
    expect(outcome.kind).toBe("blocked");
    expect(outcome.kind).not.toBe("needs_attention");
    // The drive yielded BEFORE provisioning a runner — it never raced percolation.
    expect(allocator.allocateCalls).toBe(0);
  });
});

/** A spying allocator: records allocate calls so we can assert "no runner provisioned". */
class SpyAllocator extends FakeAllocator {
  allocateCalls = 0;
  override async allocate(request: Parameters<FakeAllocator["allocate"]>[0]) {
    this.allocateCalls += 1;
    return super.allocate(request);
  }
}
