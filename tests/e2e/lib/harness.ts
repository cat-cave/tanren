// P8b — the e2e harness skeleton (autonomy-engine §8b).
//
// Drives the REAL operator flow over the REAL external surfaces only (the HTTP
// API + — for the cases that declare it — the dashboard), then asserts on REAL
// persisted artifacts (Postgres rows + the GitHub PR/contents API). It NEVER
// touches an internal seam, a fixture, or a mock — the `e2e-no-mock-imports`
// architecture check enforces that mechanically on this file.
//
// This is a runnable skeleton: `just e2e` wires the active tier-proof cases to it
// against the existing acceptance fixtures. The per-capability cases (planned in
// the manifest) grow into it as the autonomy engine lands. Reading real artifacts
// is fully implemented here (that is the gate's teeth); the live operator-flow
// orchestration is structured so each capability plugs its driver in.

import { createDbPool, type DbPool } from "@tanren/db";
import { type ArtifactEvidence, assertArtifact, type GithubPrView, type RunArtifacts } from "./artifacts.js";
import { type E2eConfig } from "./config.js";
import { type E2eCase } from "./manifest.js";

export interface CaseResult {
  readonly caseId: string;
  readonly passed: boolean;
  readonly problems: readonly string[];
  // Release evidence: the real run id + PR url the case produced.
  readonly runId?: string;
  readonly prUrl?: string;
}

// The minimum the harness needs to drive a case: which run it produced (so it can
// read that run's artifacts) and where the work landed on GitHub. A case's driver
// (the per-tier / per-capability operator flow) returns this; the harness then
// reads + asserts the real artifacts. The drivers are intentionally thin here —
// the live tier drivers are wired in cases/tierProofs.e2e.ts against the
// acceptance fixtures, never in this generic skeleton.
export interface DriverOutcome {
  readonly runId: string;
  // The PR view + implemented-file view the driver observed over the real GitHub
  // API. Optional so a planned case can be declared before its driver exists.
  readonly pr?: GithubPrView;
  readonly implementedFilePath?: string;
  readonly implementedFilePresentOnBase?: boolean;
}

export type CaseDriver = (config: E2eConfig) => Promise<DriverOutcome>;

// readRunArtifacts reads the REAL persisted run/cost/DORA rows for a run id
// straight from Postgres. This is the gate's observation surface — independent of
// any internal code path, exactly like the acceptance gate's loadRunSnapshot.
export async function readRunArtifacts(pool: DbPool, runId: string): Promise<RunArtifacts> {
  const runRow = await pool.query<{
    status: string;
    outcome: string | null;
    pr_url: string | null;
    project_id: string;
  }>("SELECT status, outcome, pr_url, project_id FROM runs WHERE run_id = $1", [runId]);
  const run = runRow.rows[0];
  if (run === undefined) {
    throw new Error(`e2e: run not found in Postgres: ${runId}`);
  }
  const costRows = await pool.query<{ task_kind: string; cost_basis: string; billing_mode: string }>(
    `SELECT t.kind AS task_kind, cr.cost_basis, cr.billing_mode
       FROM cost_records cr JOIN tasks t ON t.task_id = cr.task_id
      WHERE cr.run_id = $1 ORDER BY cr.recorded_at ASC, cr.id ASC`,
    [runId],
  );
  // The DORA projection is the count of merged deployments accumulated for the
  // run's project — a real, merge-derived row, not a function return.
  const doraRow = await pool.query<{ deployment_count: string }>(
    `SELECT COUNT(*)::text AS deployment_count
       FROM runs WHERE project_id = $1 AND outcome IS NOT NULL AND pr_url IS NOT NULL`,
    [run.project_id],
  );
  return {
    runId,
    status: run.status,
    outcome: run.outcome,
    prUrl: run.pr_url,
    costRecords: costRows.rows.map((row) => ({
      taskKind: row.task_kind,
      basis: row.cost_basis,
      billingMode: row.billing_mode,
    })),
    doraDeploymentCount: Number(doraRow.rows[0]?.deployment_count ?? "0"),
  };
}

// runCase drives one active case end-to-end: it runs the case's driver (the real
// operator flow over HTTP/dashboard), reads the real artifacts the run produced,
// and asserts every artifact the case's manifest entry declares. A planned case
// is skipped (returns a passing no-op result tagged as such) so the suite's shape
// can include forward placeholders without failing the gate.
export async function runCase(input: {
  readonly testCase: E2eCase;
  readonly driver: CaseDriver;
  readonly config: E2eConfig;
}): Promise<CaseResult> {
  const { testCase, driver, config } = input;
  if (testCase.status !== "active") {
    return { caseId: testCase.id, passed: true, problems: [`skipped (planned: ${testCase.capability})`] };
  }
  const pool = createDbPool(config.databaseUrl);
  try {
    const outcome = await driver(config);
    const run = await readRunArtifacts(pool, outcome.runId);
    const evidence: ArtifactEvidence = {
      run,
      pr: outcome.pr,
      file:
        outcome.implementedFilePath === undefined
          ? undefined
          : { path: outcome.implementedFilePath, presentOnBase: outcome.implementedFilePresentOnBase === true },
    };
    const problems = collectProblems(testCase, evidence);
    return {
      caseId: testCase.id,
      passed: problems.length === 0,
      problems,
      runId: run.runId,
      prUrl: run.prUrl ?? undefined,
    };
  } finally {
    await pool.end();
  }
}

// collectProblems runs every declared artifact assertion and returns the failures
// (empty = the case proved every real artifact it claims). Pure over its inputs
// so the harness unit test exercises the exact verdict logic the live run uses.
export function collectProblems(testCase: E2eCase, evidence: ArtifactEvidence): string[] {
  const problems: string[] = [];
  for (const artifact of testCase.artifacts) {
    const problem = assertArtifact(artifact.kind, evidence);
    if (problem !== null) {
      problems.push(`${artifact.kind}: ${problem} (${artifact.describe})`);
    }
  }
  return problems;
}
