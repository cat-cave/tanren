// NATIVE PER-TEST INGEST (the no-Actions delivery model). The native gate runs the
// repo's test step over SSH; when that step emits a JUnit report to the conventional
// workspace path, this reads it back over SSH, parses it, and persists the per-test
// rows IN-PROCESS — directly from the runner, with NO webhook, NO HMAC, NO Actions
// upload step. This is how the CI-intelligence per-test grain (flaky detection +
// quarantine over `ci_test_results`) survives the cutover: the gate produces the
// report, Tanren ingests it itself.
//
// The report path is the documented convention `reports/junit.xml` (a repo's
// `.tanren/ci.yml` test step writes it, e.g. `vitest --reporter=junit
// --outputFile=reports/junit.xml`). When the file is ABSENT the ingest is a clean
// no-op — a repo that emits no JUnit simply has no per-test grain, never an error.
// The INSERT + its event ride on the run's ambient org scope (the gate already runs
// under `runWithJobOrgId` / `runWithOrgScope`), so RLS admits them.
import type pg from "pg";
import { parseJunitReport } from "../../ci/junit.js";
import { ingestJunitResults } from "../../ci/junitIngest.js";
import type { SshTarget } from "../../contracts/allocator.js";
import type { SshSubstrate } from "../../contracts/sshSubstrate.js";
import { quoteSshShellArg } from "../../ssh/command.js";

/** The conventional workspace path a repo's test step writes its JUnit report to. */
const JUNIT_REPORT_PATH = "reports/junit.xml";

export interface IngestGateJunitInput {
  ssh: SshSubstrate;
  target: SshTarget;
  workspacePath: string;
  /** The ambient-org-scoped client the per-test INSERT + event ride (RLS-checked). */
  client: Pick<pg.Pool | pg.PoolClient, "query">;
  runId: string;
  projectId: string;
  orgId: string;
  /** The commit the gate verified (the JUnit report is about this sha). */
  headSha: string;
  timeoutMs: number;
  /** The gate's combined pass/fail — recorded as the test-step exit-code guard. */
  gatePassed: boolean;
}

/**
 * Read the runner's JUnit report (if any) for the just-run gate and ingest the
 * per-test rows in-process. A missing/empty report is a clean no-op. A genuinely
 * malformed report is a LOUD throw from `parseJunitReport` (never a silent drop that
 * would let a broken report read as all-green). Returns the rows ingested (0 = no
 * report). The caller runs this best-effort after the gate — it never gates the merge.
 */
export async function ingestGateJunit(input: IngestGateJunitInput): Promise<number> {
  const xml = await readJunitReport(input);
  if (xml === undefined) {
    return 0;
  }
  const report = parseJunitReport(xml);
  const result = await ingestJunitResults({
    client: input.client,
    run: { runId: input.runId, projectId: input.projectId, orgId: input.orgId },
    report,
    headSha: input.headSha,
    attempt: 1,
    // The native gate has no Actions re-run grain; the combined verdict is the guard:
    // a clean-looking report with a failing gate flags a runner-crash-after-write.
    testExitCode: input.gatePassed ? 0 : 1,
  });
  return result.inserted;
}

/**
 * `cat` the JUnit report over SSH when present. Emits nothing + exits 0 when the file
 * is absent (so a repo with no JUnit is a no-op, not an error); any read failure also
 * yields `undefined` so a transient hiccup degrades to "no per-test grain", never a
 * thrown gate. A non-empty body is the report text.
 */
async function readJunitReport(input: IngestGateJunitInput): Promise<string | undefined> {
  const path = `${input.workspacePath.replace(/\/+$/u, "")}/${JUNIT_REPORT_PATH}`;
  const result = await input.ssh.run(input.target, {
    command: `if [ -f ${quoteSshShellArg(path)} ]; then cat ${quoteSshShellArg(path)}; fi`,
    timeoutMs: input.timeoutMs,
  });
  if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
    return undefined;
  }
  return result.stdout.trim() === "" ? undefined : result.stdout;
}
