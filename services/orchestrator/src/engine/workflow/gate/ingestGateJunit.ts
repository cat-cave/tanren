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
// --outputFile=reports/junit.xml`). The "absent report" case is DISCRIMINATED, not
// collapsed to a silent no-op (the no-silent-fallback doctrine):
//   - `expectReport=false` (the executed tier ran NO junit-writing test step — e.g.
//     the scaffold `fast` tier is lint+typecheck) ⇒ a clean, QUIET no-op: there is
//     genuinely no per-test grain to ingest.
//   - `expectReport=true` (a test step that writes JUNIT_REPORT_PATH actually ran)
//     but the report is ABSENT / unreadable / empty ⇒ a LOUD signal carrying the
//     reason (absent vs ssh-read-failure vs empty) + tier + headSha. That state means
//     flaky-intelligence just went blind (a reporter misconfig / a runner crash after
//     the step) and MUST be visible — never a silent degrade to "no grain".
// A genuinely-malformed report is a LOUD throw from `parseJunitReport`. The INSERT +
// its event ride on the run's ambient org scope (the gate already runs under
// `runWithJobOrgId` / `runWithOrgScope`), so RLS admits them.
import type pg from "pg";
import { JUNIT_REPORT_PATH } from "../../ci/index.js";
import { parseJunitReport } from "../../ci/junit.js";
import { ingestJunitResults } from "../../ci/junitIngest.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import { quoteSshShellArg } from "../../ssh/command.js";

// The conventional workspace path a repo's test step writes its JUnit report to is
// owned by the ci module (single source of truth shared with the generated config).

export interface IngestGateJunitInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
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
  /**
   * The tier whose JUnit report this ingest reads (e.g. "slow" / "merge"). Carried
   * onto the loud `report_missing` signal so an operator sees WHICH tier emitted no
   * report. Absent ⇒ "unknown" in the signal.
   */
  tier?: string;
  /**
   * Did the executed gate tier contain a test step that writes JUNIT_REPORT_PATH?
   * Derived at the call site from the tier's steps. When TRUE, an absent/unreadable/
   * empty report is a LOUD signal (flaky-intelligence is blind). When FALSE, an absent
   * report is the expected quiet no-op (the tier ran no junit-writing test step).
   */
  expectReport: boolean;
}

// Why the runner produced no usable JUnit report. Discriminated so the loud signal
// names the actual cause instead of collapsing them to "no report".
type ReportAbsence = "absent" | "read_failed" | "empty";

// The read outcome: either the report XML, or a typed reason it was unavailable.
type ReadResult = { present: true; xml: string } | { present: false; reason: ReportAbsence };

/** The discriminated ingest outcome — never a bare 0 that hides "expected but missing". */
export type IngestGateJunitResult =
  // The report was present + parsed; `inserted` per-test rows landed.
  | { kind: "ingested"; inserted: number }
  // No report, and none was expected (the tier ran no junit-writing test step) — quiet.
  | { kind: "skipped_no_test_step" }
  // A test step ran but produced no usable report — LOUD (flaky-intelligence is blind).
  | { kind: "missing_expected"; reason: ReportAbsence };

/**
 * Read the runner's JUnit report (if any) for the just-run gate and ingest the
 * per-test rows in-process. Returns a DISCRIMINATED result (never a bare 0):
 *   - `ingested`            — the report was present + parsed; `inserted` rows landed.
 *   - `skipped_no_test_step`— `expectReport=false`: no junit-writing test step ran; a
 *                             clean QUIET no-op.
 *   - `missing_expected`    — `expectReport=true` but the report was absent / unreadable
 *                             / empty: the caller MUST surface this LOUDLY (the per-test
 *                             grain is gone though a test step ran).
 * A genuinely-malformed report is a LOUD throw from `parseJunitReport`. The caller runs
 * this best-effort after the gate — it never gates the merge (visibility, not blocking).
 */
export async function ingestGateJunit(input: IngestGateJunitInput): Promise<IngestGateJunitResult> {
  const read = await readJunitReport(input);
  if (!read.present) {
    // No usable report. Discriminate: expected (loud) vs not-expected (quiet no-op).
    return input.expectReport ? { kind: "missing_expected", reason: read.reason } : { kind: "skipped_no_test_step" };
  }
  const report = parseJunitReport(read.xml);
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
  return { kind: "ingested", inserted: result.inserted };
}

/**
 * `cat` the JUnit report over SSH, returning a DISCRIMINATED read result. The cause of
 * an absent report is preserved (never flattened to one `undefined`) so the caller can
 * report WHY when the report was expected:
 *   - `read_failed` — the SSH read itself failed/timed out/exited nonzero (a transport
 *     hiccup or a broken runner), distinct from a genuinely-missing file.
 *   - `absent`      — the read succeeded but the file does not exist (no `<...>` body).
 *   - `empty`       — the file exists but is whitespace-only (a degenerate report).
 */
async function readJunitReport(input: IngestGateJunitInput): Promise<ReadResult> {
  const path = `${input.workspacePath.replace(/\/+$/u, "")}/${JUNIT_REPORT_PATH}`;
  // The marker lets us distinguish "file absent" (marker, no body) from "file present
  // but empty" (body is whitespace) — both off a single successful SSH read.
  const result = await input.ssh.run(input.target, {
    command: `if [ -f ${quoteSshShellArg(path)} ]; then cat ${quoteSshShellArg(path)}; else echo __TANREN_JUNIT_ABSENT__; fi`,
    timeoutMs: input.timeoutMs,
  });
  if (result.failure !== undefined || result.timedOut || result.exitCode !== 0) {
    // The read itself failed — a transport/runner problem, NOT a known-absent file.
    return { present: false, reason: "read_failed" };
  }
  const body = result.stdout.trim();
  if (body === "" || body === "__TANREN_JUNIT_ABSENT__") {
    return { present: false, reason: body === "" ? "empty" : "absent" };
  }
  return { present: true, xml: result.stdout };
}
