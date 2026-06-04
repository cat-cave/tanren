// CI-intelligence ingestion (foundation): the persistence + event side of the
// JUnit upload. The route resolves the run (system-scoped, since the runner-push
// carries no tenant context), then calls `ingestJunitResults` UNDER that run's
// org scope so the per-test INSERTs and the emitted `ci.tests.reported` event
// both respect RLS (deny-by-default; a write off the wrong org is denied 42501).
//
// Append-only: each upload inserts one row per parsed `<testcase>` for this
// (run, attempt). It never updates — per-test HISTORY is the asset.

import type pg from "pg";
import { randomUUID } from "node:crypto";
import { PgEventStore } from "../eventStore.js";
import type { JunitReport } from "./junit.js";

type WriteClient = Pick<pg.Pool | pg.PoolClient, "query">;

/** The run context resolved (system-scoped) before the org-scoped write. */
export interface JunitRunContext {
  runId: string;
  projectId: string;
  orgId: string;
}

export interface IngestJunitInput {
  /** The org-scoped client (inside `runWithOrgScope`) the INSERT + event ride. */
  client: WriteClient;
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

  // Emit on the SAME org-scoped client so the event INSERT joins this txn + RLS.
  const events = new PgEventStore(client);
  await events.append({
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
