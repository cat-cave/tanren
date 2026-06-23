import { describe, expect, it } from "vitest";
import type pg from "pg";
import { runWithSystemJobScope } from "@tanren/db";
import { PgRunnerStore, RunnerClaimLiveRowError, type ClaimRunnerInput } from "../src/engine/allocators/runnerStore.js";
import { isRetriableInfraError } from "../src/engine/providers/githubRefReset.js";

// PgRunnerStore is the orchestrator-side mirror of the runners table. The
// mutation survivors here were all "no coverage": the exact SQL (INSERT vs
// UPDATE, the explicit org-id bind, the status literals, the bound parameter
// order) was never asserted. These tests capture the emitted SQL + params so a
// mutated statement (wrong column, dropped status, reordered params) is caught.
//
// org_id is bound EXPLICITLY from the caller's `orgId` ($4) — NOT derived from a
// `(SELECT org_id FROM runs …)` subquery — so a RUNLESS allocation (a Forge
// ideation runner whose runId has no matching `runs` row) still writes a valid
// tenant org and passes the runners WITH CHECK policy.
//
// The store routes its write through `withJobOrgScope`, which now REQUIRES an
// ambient scope (no silent unscoped tenant write). The runner is claimed during
// a run job, so each call runs under a per-job SYSTEM scope
// (`runWithSystemJobScope`) — exactly the null-org worker path — and the write
// lands on the system-scope connection. The pool's `connect()` returns a client
// that records only the business statement (BEGIN/COMMIT are swallowed) so the
// single-statement assertions are unchanged.

interface RecordedQuery {
  text: string;
  params: unknown[];
}

class RecordingPool {
  readonly queries: RecordedQuery[] = [];
  /**
   * The scripted `rowCount` returned for the BUSINESS INSERT/UPDATE statement
   * (transaction-control statements are inert). Defaults to 1 — the happy path
   * (fresh insert OR re-adopt of a RELEASED row, both rowCount===1) so the
   * pre-existing tests continue to assert what they always asserted. The new
   * idempotency tests script 0 to drive the typed-throw branch.
   */
  insertRowCount = 1;
  private record(text: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const trimmed = text.trim();
    const isTxControl = ["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed) || trimmed.startsWith("SET LOCAL");
    if (!isTxControl) {
      this.queries.push({ text, params });
      return { rows: [], rowCount: this.insertRowCount };
    }
    return { rows: [], rowCount: 0 };
  }
  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    return this.record(text, params);
  }
  async connect(): Promise<pg.PoolClient> {
    // `query` MUST return a thenable so `runWithSystemScope`'s rollback path can do
    // `client.query("ROLLBACK").catch(...)` on the error branch — a plain object
    // breaks the chain (`.catch is not a function`) and obscures the real throw.
    const record = (text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> =>
      Promise.resolve(this.record(text, params));
    return {
      query: (text: string, params: unknown[] = []) => record(text, params),
      release: () => {},
    } as unknown as pg.PoolClient;
  }
}

function poolAs(pool: RecordingPool): pg.Pool {
  return pool as unknown as pg.Pool;
}

const claimInput: ClaimRunnerInput = {
  runnerId: "runner_run_1",
  runId: "run_1",
  projectId: "proj_a",
  orgId: "org_a",
  allocator: "manual-ssh",
  sshHost: "10.0.0.1",
  sshPort: 2200,
  hostKeyFingerprint: "SHA256:abc",
  imageSha: "img@sha256:deadbeef",
  containerId: "host-1",
};

describe("PgRunnerStore.claim", () => {
  it("INSERTs into the runners table with the claimed status", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));

    expect(pool.queries).toHaveLength(1);
    const { text } = pool.queries[0]!;
    expect(text).toMatch(/INSERT INTO runners/u);
    expect(text).toMatch(/'claimed'/u);
  });

  it("binds org_id EXPLICITLY from the caller (no run subquery), so a runless allocation still scopes", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));

    const { text } = pool.queries[0]!;
    expect(text).toMatch(/org_id/u);
    // The org is the caller's, bound directly — the old `(SELECT org_id FROM runs
    // WHERE run_id = …)` subquery is GONE (it returned NULL for a runless Forge
    // handle and broke the runners WITH CHECK policy).
    expect(text).not.toMatch(/SELECT org_id FROM runs/u);
  });

  it("binds the claim fields in the documented parameter order (org_id is $4)", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));

    expect(pool.queries[0]!.params).toEqual([
      "runner_run_1",
      "run_1",
      "proj_a",
      "org_a",
      "manual-ssh",
      "10.0.0.1",
      2200,
      "SHA256:abc",
      "img@sha256:deadbeef",
      "host-1",
    ]);
  });

  it("passes a null orgId through verbatim (the explicit system / null-org job case)", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim({ ...claimInput, orgId: null }));

    // null is the explicit "system / null-org job" marker — bound as $4 unchanged,
    // written under the worker's BYPASSRLS system scope. Not coerced to a value.
    expect(pool.queries[0]!.params[3]).toBeNull();
  });

  it("binds NULL run_id ($2) and project_id ($3) for a runless Forge ideation claim", async () => {
    const pool = new RecordingPool();
    // The runless shape: NULL run_id/project_id (no FK target), real org_id.
    await runWithSystemJobScope(() =>
      new PgRunnerStore(poolAs(pool)).claim({ ...claimInput, runId: null, projectId: null }),
    );

    // run_id ($2) and project_id ($3) are bound NULL verbatim — the FK columns
    // stay NULL so the INSERT skips the run_id→runs / project_id→projects FKs.
    expect(pool.queries[0]!.params[1]).toBeNull();
    expect(pool.queries[0]!.params[2]).toBeNull();
    expect(pool.queries[0]!.params[3]).toBe("org_a");
  });
});

describe("PgRunnerStore.claim idempotency (task #21A)", () => {
  // apex v49 looped on `runners_pkey` because the orchestrator-side `claim()` did
  // a bare INSERT with no ON CONFLICT — a retried deterministic-handle claim
  // (job-reaper requeue / template-build re-derive) threw raw, `isRetriableInfraError`
  // defaulted it to RETRIABLE, and the merge coordinator's hold-loop re-drove
  // forever (8-hour curl hang). The fix mirrors the sidecar's `WHERE released_at
  // IS NOT NULL` re-adopt pattern and throws a typed `RunnerClaimLiveRowError`
  // (`retriable: false`) on a LIVE conflict so the doctrine path catches it.
  it("the INSERT carries the released_at-gated ON CONFLICT clause", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));

    const { text } = pool.queries[0]!;
    // Idempotent re-adopt shape: collide on runner_id, ONLY update a RELEASED row,
    // clear released_at on the re-adopt branch so the row is LIVE again.
    expect(text).toMatch(/ON CONFLICT \(runner_id\) DO UPDATE/u);
    expect(text).toMatch(/WHERE runners\.released_at IS NOT NULL/u);
    expect(text).toMatch(/released_at = NULL/u);
  });

  it("rowCount===0 (a LIVE conflict matched nothing) throws a non-retryable RunnerClaimLiveRowError", async () => {
    const pool = new RecordingPool();
    // The INSERT collided on the unique runner_id AND the conditional UPDATE
    // excluded the LIVE row (released_at IS NULL): zero rows affected. The store
    // must throw the typed error rather than silently no-op or surface a raw
    // pg error the coordinator would default to retriable.
    pool.insertRowCount = 0;

    let caught: unknown;
    try {
      await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RunnerClaimLiveRowError);
    expect((caught as RunnerClaimLiveRowError).runnerId).toBe("runner_run_1");
    // The doctrine-critical bit: the typed `retriable: false` makes
    // `isRetriableInfraError` route this to the typed-permanent path (recoverable
    // sustained-non-recovery hold), NOT the hot-loop apex v49 saw.
    expect((caught as RunnerClaimLiveRowError).retriable).toBe(false);
    expect(isRetriableInfraError(caught)).toBe(false);
  });

  it("re-claiming a RELEASED row succeeds (rowCount===1 via the ON CONFLICT update branch)", async () => {
    const pool = new RecordingPool();
    // A re-allocate of a RELEASED runner id: the conditional UPDATE matches
    // (released_at IS NOT NULL), affects exactly one row, clears released_at,
    // and resolves cleanly.
    pool.insertRowCount = 1;

    await expect(
      runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput)),
    ).resolves.toBeUndefined();
  });
});

describe("PgRunnerStore.release", () => {
  it("UPDATEs the row to released and stamps released_at, scoped by runner_id", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).release("runner_run_1"));

    expect(pool.queries).toHaveLength(1);
    const { text, params } = pool.queries[0]!;
    expect(text).toMatch(/UPDATE runners SET status = 'released'/u);
    expect(text).toMatch(/released_at = now\(\)/u);
    expect(text).toMatch(/WHERE runner_id = \$1/u);
    expect(params).toEqual(["runner_run_1"]);
  });
});
