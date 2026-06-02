import { describe, expect, it } from "vitest";
import type pg from "pg";
import { runWithSystemJobScope } from "@tanren/db";
import { PgRunnerStore, type ClaimRunnerInput } from "../src/engine/allocators/runnerStore.js";

// PgRunnerStore is the orchestrator-side mirror of the runners table. The
// mutation survivors here were all "no coverage": the exact SQL (INSERT vs
// UPDATE, the org-id tenancy subquery, the status literals, the bound
// parameter order) was never asserted. These tests capture the emitted SQL +
// params so a mutated statement (wrong column, dropped status, reordered
// params) is caught.
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
  private record(text: string, params: unknown[]): { rows: unknown[] } {
    const trimmed = text.trim();
    if (!["BEGIN", "COMMIT", "ROLLBACK"].includes(trimmed) && !trimmed.startsWith("SET LOCAL")) {
      this.queries.push({ text, params });
    }
    return { rows: [] };
  }
  async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    return this.record(text, params);
  }
  async connect(): Promise<pg.PoolClient> {
    return {
      query: (text: string, params: unknown[] = []) => this.record(text, params),
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

  it("derives org_id from the run via a subquery (tenancy hardening)", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));

    const { text } = pool.queries[0]!;
    expect(text).toMatch(/org_id/u);
    expect(text).toMatch(/SELECT org_id FROM runs WHERE run_id = \$2/u);
  });

  it("binds the claim fields in the documented parameter order", async () => {
    const pool = new RecordingPool();
    await runWithSystemJobScope(() => new PgRunnerStore(poolAs(pool)).claim(claimInput));

    expect(pool.queries[0]!.params).toEqual([
      "runner_run_1",
      "run_1",
      "proj_a",
      "manual-ssh",
      "10.0.0.1",
      2200,
      "SHA256:abc",
      "img@sha256:deadbeef",
      "host-1",
    ]);
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
