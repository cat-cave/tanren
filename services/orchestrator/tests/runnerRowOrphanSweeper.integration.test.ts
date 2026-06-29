// pg-integration for the runner-row orphan sweeper (task #9 — and the
// replacement for the now-obsolete task #11 pg-integration ask, since the
// child-progress probe its `LIKE ANY` binding lived on was deleted by the
// templating collapse in PR-F / commit 072c26a1). The sweeper's UPDATE uses
// the same array-binding family the task #11 probe used (`= ANY($N::text[])`),
// so this exercises the EXACT bind-shape regression class against a real
// Postgres — a silent mis-bind here (an `IN` vs `= ANY` change, a missing
// type-cast, a parameter swap) is caught by an actual round-trip, not by
// reading the SQL string.
//
// Gated behind `TANREN_RLS_DB_TEST=1` + a migration-owner `DATABASE_URL`, the
// SAME contract every other orchestrator pg-integration uses (see
// pgBudgetGate.integration.test.ts) so the file is SKIPPED in `just fast-check`
// and runs against a seeded DB under `just smoke`.

import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, setSystemPool } from "@tanren/db";
import { RunnerRowOrphanSweeper } from "../src/engine/allocators/runnerRowOrphanSweeper.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";

function dbName(): string {
  return `tanren_orphan_sweep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const ORG = "org_orphan_sweep";

describeDb("RunnerRowOrphanSweeper against a real Postgres (task #9)", () => {
  const database = dbName();
  let ownerPool: Pool;
  let sweeper: RunnerRowOrphanSweeper;

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();

    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    // The sweeper runs under runWithSystemScope; point the global at the
    // owner-pool so the BYPASSRLS read+write path lands on our seeded DB.
    setSystemPool(ownerPool);
    sweeper = new RunnerRowOrphanSweeper({ pool: ownerPool });

    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id, config)
       VALUES ('proj_orphan', 'p', 'https://example.com/r.git', $1, '{"version":1}'::jsonb)`,
      [ORG],
    );
  }, 60_000);

  beforeEach(async () => {
    // Each test starts from a clean runners + runs table — orphan sweep is a
    // table-spanning predicate, so leftover rows from one test would silently
    // confound the next.
    await ownerPool.query("DELETE FROM runners");
    await ownerPool.query("DELETE FROM runs");
    await ownerPool.query("DELETE FROM specs");
  });

  afterAll(async () => {
    await sweeper?.stop();
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  it("reclaims a STATIC orphan whose owning run is `completed` (the canonical post-crash leak)", async () => {
    await seedRunAndRunner({ runId: "run_done_static", runStatus: "completed", allocator: "static-runner" });
    const summary = await sweeper.tick();

    expect(summary.reclaimed).toHaveLength(1);
    expect(summary.reclaimed[0]?.runnerId).toBe("runner_run_done_static");
    expect(summary.reclaimed[0]?.allocator).toBe("static-runner");
    expect(summary.countsByAllocator).toEqual({ "static-runner": 1 });

    // The row is now RELEASED with `status='abandoned'` and a stamped `released_at`.
    const row = (await runnerRow("runner_run_done_static"))!;
    expect(row.status).toBe("abandoned");
    expect(row.released_at).not.toBeNull();
  });

  it("reclaims a MANUAL-SSH orphan whose owning run is `failed`", async () => {
    await seedRunAndRunner({ runId: "run_failed_manual", runStatus: "failed", allocator: "manual-ssh" });
    const summary = await sweeper.tick();

    expect(summary.reclaimed).toHaveLength(1);
    expect(summary.reclaimed[0]?.runnerId).toBe("runner_run_failed_manual");
    expect(summary.reclaimed[0]?.allocator).toBe("manual-ssh");
  });

  it("reclaims a MANUAL-SSH orphan whose owning run is `cancelled`", async () => {
    await seedRunAndRunner({ runId: "run_cancelled_manual", runStatus: "cancelled", allocator: "manual-ssh" });
    const summary = await sweeper.tick();

    expect(summary.reclaimed).toHaveLength(1);
    expect(summary.reclaimed[0]?.allocator).toBe("manual-ssh");
  });

  it("DOES NOT reclaim a `halted` run's row (halted is recoverable — its runner must survive)", async () => {
    // `halted` is INTENTIONALLY ABSENT from the terminal allowlist. A halted
    // run can resume; tearing down its row here would force a re-allocation
    // (and on manual_ssh, double-book the host the lease still expects).
    await seedRunAndRunner({ runId: "run_halted", runStatus: "halted", allocator: "static-runner" });
    const summary = await sweeper.tick();

    expect(summary.reclaimed).toEqual([]);
    const row = (await runnerRow("runner_run_halted"))!;
    expect(row.released_at).toBeNull();
  });

  it("DOES NOT reclaim a `running` run's row (a live in-flight run is never touched, regardless of age)", async () => {
    // Sign-of-life over wall-clock: the run is still genuinely in flight, so
    // its runner row stays LIVE no matter how old it is. The eradication
    // program's core invariant ("kill only on evidence of death") at the
    // row-reconciler level.
    await seedRunAndRunner({ runId: "run_running", runStatus: "running", allocator: "static-runner" });
    const summary = await sweeper.tick();

    expect(summary.reclaimed).toEqual([]);
  });

  it("DOES NOT reclaim a SIDECAR row (cloud/sidecar rows are owned by another teardown layer)", async () => {
    // The cloud allocators destroy their droplet/container on release; the
    // sidecar service runs its own RunnerSweeper. A sidecar entry in the
    // orchestrator's sweep allowlist would silently double-release rows whose
    // teardown is owned elsewhere.
    await seedRunAndRunner({ runId: "run_sidecar_done", runStatus: "completed", allocator: "sidecar-docker" });
    const summary = await sweeper.tick();

    expect(summary.reclaimed).toEqual([]);
    const row = (await runnerRow("runner_run_sidecar_done"))!;
    expect(row.released_at).toBeNull();
  });

  it("DOES NOT reclaim a HETZNER row (cloud kinds excluded)", async () => {
    await seedRunAndRunner({ runId: "run_hetzner_done", runStatus: "completed", allocator: "hetzner" });
    const summary = await sweeper.tick();

    expect(summary.reclaimed).toEqual([]);
  });

  it("a second tick over the same DB state reclaims NOTHING NEW (idempotent — `released_at IS NULL` filters out done rows)", async () => {
    await seedRunAndRunner({ runId: "run_idem", runStatus: "completed", allocator: "static-runner" });
    const first = await sweeper.tick();
    const second = await sweeper.tick();

    expect(first.reclaimed).toHaveLength(1);
    expect(second.reclaimed).toEqual([]);
  });

  it("preserves the row's org_id on reclaim (the released row stays tenant-attributable for audits)", async () => {
    await seedRunAndRunner({ runId: "run_org", runStatus: "completed", allocator: "manual-ssh" });
    const summary = await sweeper.tick();

    expect(summary.reclaimed[0]?.orgId).toBe(ORG);
    const row = (await runnerRow("runner_run_org"))!;
    expect(row.org_id).toBe(ORG);
  });

  it("reclaims MULTIPLE orphans (mixed static + manual-ssh + mixed terminal statuses) in ONE atomic statement", async () => {
    // The atomic single-statement shape — same bind exercises the array `= ANY`
    // semantics on both allowlists (the task #11 LIKE-ANY-class regression
    // shape) in one round trip.
    await seedRunAndRunner({ runId: "run_a", runStatus: "completed", allocator: "static-runner" });
    await seedRunAndRunner({ runId: "run_b", runStatus: "failed", allocator: "manual-ssh" });
    await seedRunAndRunner({ runId: "run_c", runStatus: "cancelled", allocator: "manual-ssh" });
    // Negatives that share the table:
    await seedRunAndRunner({ runId: "run_d", runStatus: "halted", allocator: "static-runner" });
    await seedRunAndRunner({ runId: "run_e", runStatus: "running", allocator: "manual-ssh" });
    await seedRunAndRunner({ runId: "run_f", runStatus: "completed", allocator: "digitalocean" });

    const summary = await sweeper.tick();
    const runnerIds = new Set(summary.reclaimed.map((r) => r.runnerId));

    expect(runnerIds).toEqual(new Set(["runner_run_a", "runner_run_b", "runner_run_c"]));
    expect(summary.countsByAllocator).toEqual({ "static-runner": 1, "manual-ssh": 2 });
  });

  // Seed a `runs` row + matching `runners` row (LIVE — released_at IS NULL).
  async function seedRunAndRunner(input: { runId: string; runStatus: string; allocator: string }): Promise<void> {
    const specId = `spec_${input.runId}`;
    const runnerId = `runner_${input.runId}`;
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description)
       VALUES ($1, 'proj_orphan', $2, 't', 'd')`,
      [specId, ORG],
    );
    await ownerPool.query(
      `INSERT INTO runs (run_id, spec_id, project_id, org_id, trigger, branch, status)
       VALUES ($1, $2, 'proj_orphan', $3, 'cli', 'main', $4)`,
      [input.runId, specId, ORG, input.runStatus],
    );
    await ownerPool.query(
      `INSERT INTO runners (
         runner_id, run_id, project_id, org_id, allocator, status,
         ssh_host, ssh_port, host_key_fingerprint, image_sha, container_id
       )
       VALUES ($1, $2, 'proj_orphan', $3, $4, 'claimed',
               '10.0.0.1', 22, 'SHA256:fp', 'img@sha256:x', $1)`,
      [runnerId, input.runId, ORG, input.allocator],
    );
  }

  async function runnerRow(
    runnerId: string,
  ): Promise<{ status: string; released_at: Date | null; org_id: string } | undefined> {
    const result = await ownerPool.query<{ status: string; released_at: Date | null; org_id: string }>(
      "SELECT status, released_at, org_id FROM runners WHERE runner_id = $1",
      [runnerId],
    );
    return result.rows[0];
  }
});
