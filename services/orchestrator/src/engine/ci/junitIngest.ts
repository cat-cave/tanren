// CI-intelligence ingestion (foundation): the persistence + event side of the
// JUnit upload. The native gate ingest resolves the run under its org scope, then calls
// `ingestJunitResults` so the per-test INSERTs respect RLS (deny-by-default).
//
// PLANE-SPLIT: `ci_test_results` is a DATA-PLANE table (the de-privileged
// `tanren_dataplane` role keeps full write on it), so the per-test rows INSERT directly
// on the org-scoped `client`. The emitted `ci.tests.reported` event lands in `events` —
// a CONTROL-PLANE table the data plane can no longer write directly (migration 0031) —
// so it routes through the caller's `EventStore` (the run-state writer when remote-writes
// is on, else the in-process `PgEventStore`), exactly like every other workflow event.
//
// Append-only: each upload inserts one row per parsed `<testcase>` for this
// (run, attempt). It never updates — per-test HISTORY is the asset.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { EventStore } from "../eventStore.js";
import type { JunitReport } from "./junit.js";

type WriteClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The run context resolved (system-scoped) before the org-scoped write. */
export interface JunitRunContext {
  runId: string;
  projectId: string;
  orgId: string;
}

export interface IngestJunitInput {
  /** The org-scoped client the per-test `ci_test_results` INSERTs run on (a data-plane table). */
  client: WriteClient;
  /**
   * The event store the `ci.tests.reported` append routes through — the run-state writer
   * (control plane) when remote-writes is on, else the in-process `PgEventStore`. `events`
   * is a control-plane table the data plane cannot write directly, so the event NEVER goes
   * straight to `client`.
   */
  eventStore: EventStore;
  run: JunitRunContext;
  report: JunitReport;
  /** The commit SHA the report was produced against (CI `github.sha`). */
  headSha: string;
  /** The CI re-run attempt (GitHub `run_attempt`), ≥ 1. */
  attempt: number;
  /**
   * The test-step exit code the runner reported (the `--test-exit-code` guard).
   * A non-zero code with a clean-looking report flags a runner-crash-after-write;
   * it is recorded on the event so a later phase never reads it as "all green".
   * Null when the uploader did not supply one.
   */
  testExitCode: number | null;
}

export interface IngestJunitResult {
  /** Rows inserted (== `report.results.length`). */
  inserted: number;
  /** Cases that showed a fail-then-pass within this run (single-run flaky). */
  flaky: number;
}

/**
 * Persist the parsed per-test rows and emit `ci.tests.reported`. MUST be called
 * inside an org scope (the passed `client` is the scoped transaction client) so
 * the writes are RLS-checked against the run's org.
 */
export async function ingestJunitResults(input: IngestJunitInput): Promise<IngestJunitResult> {
  const { client, run, report, headSha, attempt } = input;
  let flaky = 0;
  for (const result of report.results) {
    if (result.flakyFailure) flaky += 1;
    await client.query(
      `INSERT INTO ci_test_results
         (id, project_id, org_id, test_id, file, suite, head_sha, run_id, attempt, outcome, duration_ms, retries, observed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
      [
        randomUUID(),
        run.projectId,
        run.orgId,
        result.testId,
        result.file,
        result.suite,
        headSha,
        run.runId,
        attempt,
        result.outcome,
        result.durationMs,
        result.retries,
      ],
    );
  }

  // Emit through the caller's event store — the control-plane writer when remote-writes
  // is on (the data plane cannot INSERT `events` directly), else the in-process store.
  await input.eventStore.append({
    runId: run.runId,
    projectId: run.projectId,
    eventType: "ci.tests.reported",
    payload: {
      headSha,
      attempt,
      total: report.total,
      failures: report.failures,
      flaky,
      testExitCode: input.testExitCode,
    },
  });

  return { inserted: report.results.length, flaky };
}
