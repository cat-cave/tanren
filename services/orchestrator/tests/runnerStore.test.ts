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
      // provider_metadata ($11) — null for the manual-ssh claim above (no
      // external cloud teardown descriptor to persist); the cloud allocators
      // (DO/GCP/AWS/K8s/Hetzner) pass a discriminated JSON string. See the
      // Codex H3 #13 fix.
      null,
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

describe("PgRunnerStore.claim — lockstep created_at on re-adopt (task #8)", () => {
  // Task #8: a re-adopt of a RELEASED runner_id (orchestrator restart, lease
  // takeover, job-reaper requeue) MUST preserve the ORIGINAL `created_at`. The
  // ON CONFLICT branch pins `created_at = runners.created_at` explicitly — a
  // deliberate no-op SQL that documents the invariant in the statement itself
  // (rather than leaving it implicit-by-omission). A mutation that switches it
  // to `EXCLUDED.created_at` would silently re-stamp the row to `now()` and
  // warp every downstream signal that keys off allocation age (oldest-first
  // sweeper ordering, DORA timing). These tests pin BOTH that the locking
  // clause is present AND that the wrong shape (`EXCLUDED.created_at`) is
  // absent, so neither direction of the mutation slides through.
  it("the UPDATE branch pins created_at to runners.created_at (the existing row's value)", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));

    const { text } = pool.queries[0]!;
    // The lockstep no-op: `created_at = runners.created_at` — the existing
    // row's value, NOT EXCLUDED.created_at (which would resolve to the INSERT
    // attempt's default `now()` and re-stamp the row).
    expect(text).toMatch(/created_at\s*=\s*runners\.created_at/u);
  });

  it("the UPDATE branch never re-sets created_at to EXCLUDED.created_at (the bug shape)", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));

    const { text } = pool.queries[0]!;
    // The bug shape #8 names: `created_at = EXCLUDED.created_at` would resolve
    // to the INSERT attempt's `now()` default and silently re-set the row's
    // original allocation timestamp on every re-adopt — breaking oldest-first
    // ordering + DORA timing. Pin its absence so a future mutation cannot
    // sneak it in.
    expect(text).not.toMatch(/created_at\s*=\s*EXCLUDED\.created_at/u);
  });

  it("created_at is NOT in the INSERT column list (the DB DEFAULT now() stamps a fresh row)", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));

    const { text } = pool.queries[0]!;
    // A FRESH insert (no conflict): `created_at` is intentionally absent from
    // the INSERT columns so the table's `DEFAULT now()` stamps it. Asserting on
    // the INSERT column block (the parenthesized list immediately after `INTO
    // runners`) makes this pin specific — the UPDATE SET clause's
    // `created_at = runners.created_at` lockstep above must NOT bleed into the
    // INSERT column list (which would require a matching VALUES entry).
    const insertColsMatch = /INSERT\s+INTO\s+runners\s*\(([\s\S]*?)\)/u.exec(text);
    expect(insertColsMatch).not.toBeNull();
    expect(insertColsMatch![1]).not.toMatch(/\bcreated_at\b/u);
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

// Codex H3 Surface 5 #13: the cloud allocator teardown descriptor is written
// alongside the row so a fresh allocator instance (post-restart) can
// reconstruct the DELETE from the DB — the in-memory `Map` a cold-boot loses.
// Pin the shape: (a) provider_metadata IS in the INSERT column list; (b) it
// binds as $11 with a JSON string (jsonb-castable) OR null; (c) the ON CONFLICT
// re-adopt branch also updates provider_metadata so a re-claim of a released
// row picks up the new descriptor. Absence of any of these silently
// re-introduces the leak.
describe("PgRunnerStore.claim — provider_metadata persistence (Codex H3 #13)", () => {
  it("binds a discriminated blob as a JSON string in the documented $11 slot", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() =>
      new PgRunnerStore(poolAs(pool)).claim({
        ...claimInput,
        providerMetadata: { kind: "digitalocean", dropletId: 99 },
      }),
    );

    // pg binds objects poorly for jsonb columns (it stringifies to `[object
    // Object]`). The store serializes to JSON explicitly + casts `$11::jsonb`
    // in the SQL so the bind is a first-class jsonb literal.
    expect(pool.queries[0]!.params[10]).toBe(JSON.stringify({ kind: "digitalocean", dropletId: 99 }));
    expect(pool.queries[0]!.text).toMatch(/provider_metadata/u);
    expect(pool.queries[0]!.text).toMatch(/\$11::jsonb/u);
  });

  it("the ON CONFLICT re-adopt branch also updates provider_metadata", async () => {
    // Without this, a re-claim of a RELEASED runner id would keep the OLD
    // provider_metadata pointing at the prior droplet/instance/pod — the fresh
    // release would then reconstruct the WRONG teardown (deleting a resource
    // that already went away, or worse, missing the new one).
    const pool = new RecordingPool();
    await runWithSystemJobScope(() =>
      new PgRunnerStore(poolAs(pool)).claim({
        ...claimInput,
        providerMetadata: { kind: "digitalocean", dropletId: 42 },
      }),
    );

    const { text } = pool.queries[0]!;
    expect(text).toMatch(/provider_metadata\s*=\s*EXCLUDED\.provider_metadata/u);
  });

  it("null when the caller passes no descriptor (the long-lived / non-cloud allocator kinds)", async () => {
    const pool = new RecordingPool();
    // manual-ssh / static-runner never populate providerMetadata — a bind
    // of `null` (not the string "null") lets the SQL cast to a genuine jsonb
    // NULL rather than a JSON-encoded null literal that could confuse a
    // `IS NULL` predicate.
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));
    expect(pool.queries[0]!.params[10]).toBeNull();
  });
});

describe("PgRunnerStore.readTeardownDescriptor (Codex H3 #13)", () => {
  // The cold-start release fallback: a fresh allocator instance reads the
  // persisted descriptor from `runners.provider_metadata` (LIVE row only)
  // when its in-memory map has been lost. Pin the SQL: (a) select
  // provider_metadata, (b) restrict to `released_at IS NULL`, (c) `undefined`
  // for a missing OR already-released row (both are correct no-op signals
  // for the release path).
  it("SELECTs provider_metadata for a LIVE runner (`released_at IS NULL`)", async () => {
    class LiveRowPool extends RecordingPool {
      async connect(): Promise<pg.PoolClient> {
        const record = (text: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
          const trimmed = text.trim();
          const isTx = ["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed) || trimmed.startsWith("SET LOCAL");
          if (isTx) return Promise.resolve({ rows: [], rowCount: 0 });
          this.queries.push({ text, params });
          return Promise.resolve({
            rows: [{ provider_metadata: { kind: "digitalocean", dropletId: 99 } }],
            rowCount: 1,
          });
        };
        return { query: (t: string, p: unknown[] = []) => record(t, p), release: () => {} } as unknown as pg.PoolClient;
      }
    }
    const pool = new LiveRowPool();

    const result = await runWithSystemJobScope(() =>
      new PgRunnerStore(poolAs(pool)).readTeardownDescriptor("runner_run_1"),
    );
    expect(result).toEqual({ kind: "digitalocean", dropletId: 99 });
    const { text, params } = pool.queries[0]!;
    expect(text).toMatch(/SELECT provider_metadata/u);
    expect(text).toMatch(/released_at IS NULL/u);
    expect(params).toEqual(["runner_run_1"]);
  });

  it("undefined for a missing OR already-released row (both are release no-op signals)", async () => {
    // RecordingPool returns 0 rows by default → the release path treats it as no-op.
    const pool = new RecordingPool();
    const result = await runWithSystemJobScope(() =>
      new PgRunnerStore(poolAs(pool)).readTeardownDescriptor("runner_missing"),
    );
    expect(result).toBeUndefined();
  });
});
