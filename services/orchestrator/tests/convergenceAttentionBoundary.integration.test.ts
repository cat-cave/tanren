// THE OPERATOR-REQUEUE CONVERGENCE BOUNDARY — the regression proof, against a REAL
// Postgres (no SQL mocks; the boundary IS a SQL predicate, so a fake pool could only
// re-assert the string we wrote).
//
// THE DEFECT: when a spec's run fails, `runFinalizeAuthority.decideFromCode` escalates it
// to the terminal `needs_attention` status once the convergence detector reports a fixed
// point. Both fixed-point readers — `workflow/redriveHistoryReader.ts` (planner path) and
// `worker/orphanConsecutiveReader.ts` (orphan/crash path) — read the spec's `dag.spec.redriven`
// history UNBOUNDED. The operator requeue path (`workflow/requeueAttentionSpec.ts`) flips the
// spec back to `open` and emits `dag.spec.attention_resolved`, but that event had ZERO
// consumers. So a requeued spec re-entered the DAG carrying its ENTIRE prior failure history
// and the very NEXT failure of the same classified code re-tripped cycle detection and
// re-parked it. Live evidence from a running instance: four specs each requeued 3-4 times and
// re-parked 4-5 times — the operator's requeue bought at most one attempt.
//
// THE FIX (`workflow/attentionResolutionBoundary.ts`): both readers restrict the history to
// rows strictly AFTER the spec's most recent `dag.spec.attention_resolved`, compared on
// `events.id` (a `bigserial` PK — no tie ambiguity) rather than `ts` (a transaction clock
// that events routinely share). No resolution event ⇒ the full history, exactly as before.
//
// Gated behind TANREN_RLS_DB_TEST=1 + an owner/superuser DATABASE_URL (the migration role),
// exactly like the rest of the integration cohort. Wired into `just smoke` via
// `just smoke-convergence-attention-boundary`.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, runWithOrgScope } from "@tanren/db";
import { PgEventStore } from "../src/engine/eventStore.js";
import { readOrphanConsecutive } from "../src/engine/worker/orphanConsecutiveReader.js";
import type { ClassifiedRunFailure } from "../src/engine/worker/runFailureClassifier.js";
import { buildRedriveHistoryReader } from "../src/engine/workflow/redriveHistoryReader.js";

const enabled = process.env["TANREN_RLS_DB_TEST"] === "1";
const describeDb = enabled ? describe : describe.skip;

const ADMIN_URL = process.env["DATABASE_URL"] ?? "postgres://tanren:tanren@localhost:5432/tanren";
const ORG = "org_conv_boundary";
const PROJECT = "proj_conv_boundary";

function dbName(): string {
  return `tanren_conv_boundary_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The classified failure the readers are asked about — the SAME code/stage the seeded
 * history repeats, so the convergence judge sees a genuine same-failure cycle. */
const INTERNAL_AT_RUN: ClassifiedRunFailure = {
  code: "internal",
  stage: "run",
  summary: "the run failed with an internal error",
};

describeDb("operator-requeue convergence boundary — dag.spec.attention_resolved bounds the re-drive history", () => {
  const database = dbName();
  let ownerPool: Pool;
  /** Monotonic suffix so every seeded re-drive carries a distinct `runId` in its payload. */
  let seq = 0;

  /** `events` carries a composite `(org_id, spec_id)` lineage FK onto `specs`, so every
   * spec an event hangs off must exist. Idempotent — each test names its own spec. */
  async function ensureSpec(specId: string): Promise<void> {
    await ownerPool.query(
      `INSERT INTO specs (spec_id, project_id, org_id, title, description, status)
       VALUES ($1, $2, $3, 't', 'd', 'open') ON CONFLICT (spec_id) DO NOTHING`,
      [specId, PROJECT, ORG],
    );
  }

  /** Append a `dag.spec.redriven` row through the CANONICAL writer (`PgEventStore` — the
   * repo's single events writer), so the boundary is proven against rows shaped and validated
   * exactly the way production writes them, not hand-rolled INSERTs. */
  async function redriven(
    specId: string,
    payload: { failureCode: string; stage?: string; workSignature?: string; source?: string },
  ): Promise<void> {
    await ensureSpec(specId);
    seq += 1;
    await runWithOrgScope(ownerPool, ORG, (client) =>
      new PgEventStore(client).append({
        specId,
        projectId: PROJECT,
        orgId: ORG,
        eventType: "dag.spec.redriven",
        payload: {
          specId,
          runId: `run_seed_${seq}`,
          stage: "run",
          consecutiveSameFailure: 1,
          backoffSeconds: 5,
          ...payload,
        } as never,
      }),
    );
  }

  /** Append the operator's `dag.spec.attention_resolved` row — the budget-reset boundary —
   * through the same canonical writer the requeue endpoint uses. */
  async function resolved(specId: string): Promise<void> {
    await ensureSpec(specId);
    await runWithOrgScope(ownerPool, ORG, (client) =>
      new PgEventStore(client).append({
        specId,
        projectId: PROJECT,
        orgId: ORG,
        eventType: "dag.spec.attention_resolved",
        payload: { specId, fromSource: "strand", resolvedBy: "user_operator" } as never,
      }),
    );
  }

  /** Collapse EVERY one of the spec's event timestamps onto one instant — the ordering tie the
   * id-keyed boundary has to survive. `events.ts` defaults to the TRANSACTION clock, so events
   * written together genuinely share it; this makes that the whole history. (An UPDATE, not an
   * event write — the single-event-writer invariant stands.) */
  async function collapseTimestamps(specId: string): Promise<void> {
    await ownerPool.query("UPDATE events SET ts = '2026-01-01T00:00:00Z'::timestamptz WHERE spec_id = $1", [specId]);
  }

  /** The planner-path verdict: 1 ⇒ a proven fixed point (the authority parks the spec at
   * `needs_attention`); 0 ⇒ progress (re-drive). Throws loudly on a read failure. */
  async function plannerFixedPoint(specId: string, code = "internal"): Promise<number> {
    const reader = buildRedriveHistoryReader(ownerPool);
    const result = await reader({ orgId: ORG, specId, code: code as never, stage: "run" });
    if (result.kind !== "ok") throw new Error(`expected an ok read but got ${result.kind}`);
    return result.priorSameFixedPoint;
  }

  /** The planner-path WANDERING verdict (the second convergence signal, apex v67 #122) —
   * assembled from the SAME bounded row set, so the boundary must reset it too. */
  async function plannerWandering(specId: string, code: string): Promise<boolean> {
    const reader = buildRedriveHistoryReader(ownerPool);
    const result = await reader({ orgId: ORG, specId, code: code as never, stage: "agent" });
    if (result.kind !== "ok") throw new Error(`expected an ok read but got ${result.kind}`);
    return result.wandering.wandering;
  }

  /** The orphan/crash-path verdict, over a real org-scoped client. */
  async function orphanConsecutive(specId: string): Promise<number> {
    const client = await ownerPool.connect();
    try {
      const result = await readOrphanConsecutive(client, specId, INTERNAL_AT_RUN);
      if (result.kind !== "ok") throw new Error(`expected an ok read but got ${result.kind}`);
      return result.consecutive;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(`CREATE DATABASE ${database}`);
    await adminPool.end();
    ownerPool = new Pool({ connectionString: withDatabase(ADMIN_URL, database) });
    await migrate(ownerPool);
    await ownerPool.query(
      `INSERT INTO organizations (id, kind, external_id, login, display_name, config)
       VALUES ($1, 'oidc', $1, $1, $1, '{"version":1}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [ORG],
    );
    await ownerPool.query(
      `INSERT INTO projects (project_id, name, repo_url, org_id)
       VALUES ($1, 'p', 'https://example.com/r.git', $2) ON CONFLICT (project_id) DO NOTHING`,
      [PROJECT, ORG],
    );
  }, 60_000);

  afterAll(async () => {
    await ownerPool?.end();
    const adminPool = new Pool({ connectionString: ADMIN_URL });
    await adminPool.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [database],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS ${database}`);
    await adminPool.end();
  }, 30_000);

  // ─── planner path (workflow/redriveHistoryReader.ts) ──────────────────────────────────

  // (1) TODAY'S BEHAVIOR, PRESERVED. Three same-code re-drives + the current same-code
  // failure is a proven cycle ⇒ escalate. This is the case the boundary must NOT weaken.
  it("(1) planner: 3 same-code re-drives and NO resolution event ⇒ escalates (unchanged)", async () => {
    const specId = "spec_planner_no_resolution";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal" });
    expect(await plannerFixedPoint(specId)).toBe(1);
  });

  // (2) THE REGRESSION BEING FIXED. Same three same-code re-drives, THEN the operator
  // requeues (`dag.spec.attention_resolved`), THEN ONE more same-code failure. Post-boundary
  // the spec has exactly one prior — not a cycle ⇒ re-drive, NOT an instant re-park.
  // Pre-fix this returned 1: the requeue bought the spec a single attempt.
  it("(2) planner: 3 re-drives → attention_resolved → 1 re-drive ⇒ does NOT escalate (the fix)", async () => {
    const specId = "spec_planner_requeued_once";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal" });
    await resolved(specId);
    await redriven(specId, { failureCode: "internal" });
    expect(await plannerFixedPoint(specId)).toBe(0);
  });

  // (3) THE BOUNDARY RESETS THE BUDGET, IT DOES NOT DISABLE ESCALATION. Three MORE same-code
  // re-drives after the resolution re-establish the cycle on post-boundary evidence alone.
  it("(3) planner: 3 re-drives → attention_resolved → 3 more re-drives ⇒ escalates again", async () => {
    const specId = "spec_planner_requeued_then_stuck";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal" });
    await resolved(specId);
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal" });
    expect(await plannerFixedPoint(specId)).toBe(1);
  });

  // (4) THE BOUNDARY IS PER-SPEC. Another spec's resolution must never bound this one's
  // history (a subquery that dropped `spec_id = $1` would silently blank every spec's
  // history the moment ANY spec was requeued).
  it("(4) planner: a resolution on a DIFFERENT spec does NOT bound this spec's history", async () => {
    const other = "spec_planner_other_requeued";
    const specId = "spec_planner_unaffected";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal" });
    await resolved(other);
    expect(await plannerFixedPoint(specId)).toBe(1);
  });

  // (5) TIES ON `ts`. The boundary compares on `events.id` (bigserial, unique) precisely
  // because `ts` defaults to the TRANSACTION clock — a resolution and the re-drives around it
  // can share a timestamp to the microsecond. Every row here carries the SAME `ts`; only an
  // id-keyed boundary keeps the three POST-resolution re-drives (⇒ escalate). A `ts >`
  // boundary drops all of them and reports progress; a `ts >=` boundary keeps the
  // PRE-resolution ones too.
  it("(5) planner: rows sharing one `ts` are split correctly by the id-keyed boundary", async () => {
    const specId = "spec_planner_ts_tie";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal" });
    await resolved(specId);
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal" });
    await collapseTimestamps(specId);
    expect(await plannerFixedPoint(specId)).toBe(1);
  });

  // (6) THE PROBER-RESUME FILTER SURVIVES THE BOUNDARY (audit finding #13). Post-resolution
  // `prober_resume` rows are still filtered at assembly time, so they neither pad the fresh
  // budget nor defeat cycle detection within it.
  it("(6) planner: post-resolution prober_resume rows are still filtered out of the fresh history", async () => {
    const specId = "spec_planner_prober_after_resolution";
    await redriven(specId, { failureCode: "internal" });
    await resolved(specId);
    await redriven(specId, { failureCode: "internal" });
    await redriven(specId, { failureCode: "usage_limit", source: "prober_resume" });
    await redriven(specId, { failureCode: "internal" });
    // Two structural priors after the boundary + the current failure ⇒ a cycle ⇒ escalate.
    expect(await plannerFixedPoint(specId)).toBe(1);
  });

  // (7) THE WANDERING WINDOW RESETS TOO. The wandering-halt detector (threshold 5) derives
  // from the SAME bounded row set. Five no-progress re-drives with DIFFERENT codes at one
  // stage is a wandering halt; after a requeue the window must start over.
  it("(7) planner: 5 no-progress re-drives ⇒ wandering; the same history behind a resolution ⇒ not wandering", async () => {
    const wandered = "spec_planner_wandering";
    const requeued = "spec_planner_wandering_requeued";
    const codes = ["workspace", "internal", "merge", "credential", "workspace"];
    for (const failureCode of codes) await redriven(wandered, { failureCode, stage: "agent" });
    expect(await plannerWandering(wandered, "internal")).toBe(true);

    for (const failureCode of codes) await redriven(requeued, { failureCode, stage: "agent" });
    await resolved(requeued);
    await redriven(requeued, { failureCode: "workspace", stage: "agent" });
    // Post-boundary the window holds one prior + the current attempt — far short of 5.
    expect(await plannerWandering(requeued, "internal")).toBe(false);
  });

  // ─── orphan / crash path (worker/orphanConsecutiveReader.ts) ──────────────────────────

  // (8) TODAY'S BEHAVIOR, PRESERVED (the orphan sibling of (1)).
  it("(8) orphan: 3 same-signature re-drives and NO resolution event ⇒ escalates (unchanged)", async () => {
    const specId = "spec_orphan_no_resolution";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    expect(await orphanConsecutive(specId)).toBe(1);
  });

  // (9) THE REGRESSION BEING FIXED, on the orphan path (the sibling of (2)).
  it("(9) orphan: 3 re-drives → attention_resolved → 1 re-drive ⇒ does NOT escalate (the fix)", async () => {
    const specId = "spec_orphan_requeued_once";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    await resolved(specId);
    await redriven(specId, { failureCode: "internal", stage: "run" });
    expect(await orphanConsecutive(specId)).toBe(0);
  });

  // (10) THE BOUNDARY RESETS THE BUDGET, IT DOES NOT DISABLE ESCALATION (the sibling of (3)).
  it("(10) orphan: 3 re-drives → attention_resolved → 3 more re-drives ⇒ escalates again", async () => {
    const specId = "spec_orphan_requeued_then_stuck";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    await resolved(specId);
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    expect(await orphanConsecutive(specId)).toBe(1);
  });

  // (11) THE BOUNDARY IS PER-SPEC, on the orphan path (the sibling of (4)).
  it("(11) orphan: a resolution on a DIFFERENT spec does NOT bound this spec's history", async () => {
    const other = "spec_orphan_other_requeued";
    const specId = "spec_orphan_unaffected";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    await resolved(other);
    expect(await orphanConsecutive(specId)).toBe(1);
  });

  // (12) TIES ON `ts`, on the orphan path (the sibling of (5)).
  it("(12) orphan: rows sharing one `ts` are split correctly by the id-keyed boundary", async () => {
    const specId = "spec_orphan_ts_tie";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    await resolved(specId);
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    await collapseTimestamps(specId);
    expect(await orphanConsecutive(specId)).toBe(1);
  });

  // (13) THE ORPHAN STAGE-ENRICHED SIGNATURE SURVIVES THE BOUNDARY. Post-resolution crashes
  // at a DIFFERENT stage are a different signature ⇒ progress, not a cycle.
  it("(13) orphan: post-resolution crashes at a different STAGE read as progress, not a cycle", async () => {
    const specId = "spec_orphan_stage_enriched";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    await resolved(specId);
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "bootstrap" });
    // The current failure is `internal@run`; every post-boundary prior is `internal@bootstrap`
    // ⇒ the latest attempt advanced ⇒ progress.
    expect(await orphanConsecutive(specId)).toBe(0);
  });

  // ─── repeat requeues: the LATEST resolution is the boundary ───────────────────────────

  // (14)/(15) A spec requeued TWICE is bounded by its MOST RECENT resolution, not its first.
  // The live evidence is exactly this shape — specs requeued 3-4 times — so a boundary keyed
  // to the oldest resolution would leave the second requeue buying one attempt all over again.
  it("(14) planner: after a SECOND requeue only the latest resolution bounds the history", async () => {
    const specId = "spec_planner_requeued_twice";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal" });
    await resolved(specId);
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal" });
    await resolved(specId);
    await redriven(specId, { failureCode: "internal" });
    // One prior since the SECOND resolution ⇒ not a cycle. (Bounded by the FIRST resolution
    // instead, the reader would see four priors and re-park the spec immediately.)
    expect(await plannerFixedPoint(specId)).toBe(0);
  });

  it("(15) orphan: after a SECOND requeue only the latest resolution bounds the history", async () => {
    const specId = "spec_orphan_requeued_twice";
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    await resolved(specId);
    for (let i = 0; i < 3; i += 1) await redriven(specId, { failureCode: "internal", stage: "run" });
    await resolved(specId);
    await redriven(specId, { failureCode: "internal", stage: "run" });
    expect(await orphanConsecutive(specId)).toBe(0);
  });
});
