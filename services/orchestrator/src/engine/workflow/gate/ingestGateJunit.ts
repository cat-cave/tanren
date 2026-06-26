// NATIVE PER-TEST INGEST (the no-Actions delivery model). The native gate runs the
// repo's test step over SSH; when that step DECLARES a JUnit report path (the
// `junitReport` field on the `.tanren/ci.yml` step), this reads it back over SSH at
// that declared path, parses it, and persists the per-test rows IN-PROCESS — directly
// from the runner, with NO webhook, NO HMAC, NO Actions upload step. This is how the
// CI-intelligence per-test grain (flaky detection + quarantine over `ci_test_results`)
// survives the cutover: the gate produces the report, Tanren ingests it itself.
//
// The report path is a DECLARED CI-config contract field (`junitReport: <path>`), not a
// command-string sniff: a project's test command (`just tier-2`) does not mention the
// path, so "is JUnit expected" is decided from the declared field, never a substring.
// STACK-AGNOSTIC: the path is the project's own declaration (`reports/junit.xml` by
// convention, but any path the project says it writes). The "absent report" case is
// DISCRIMINATED, not collapsed to a silent no-op (the no-silent-fallback doctrine):
//   - `expectReport=false` (no executed tier DECLARED a junitReport — e.g. the scaffold
//     `fast` tier is lint+typecheck) ⇒ a clean, QUIET no-op: genuinely no grain to ingest.
//   - `expectReport=true` (a tier DECLARED a junitReport path and its step ran) but the
//     report is ABSENT / unreadable / empty ⇒ a LOUD, DURABLE signal carrying the reason
//     (absent vs ssh-read-failure vs empty) + tier + headSha (the caller emits a
//     `ci.junit_missing` event + a console.error). That state means flaky-intelligence
//     just went blind (a reporter misconfig / a runner crash after the step) and MUST be
//     visible — never a silent degrade to "no grain".
// A genuinely-malformed report is a LOUD throw from `parseJunitReport`. The per-test
// `ci_test_results` INSERT rides the run's ambient org scope (the gate already runs under
// `runWithJobOrgId` / `runWithOrgScope`) on the data-plane role that keeps that grant; the
// `ci.tests.reported` event routes through the caller's `EventStore` (the control-plane
// writer when remote-writes is on — the data plane can't INSERT `events` directly).
import type pg from "pg";
import { type JunitReport, parseJunitReport } from "../../ci/junit.js";
import { ingestJunitResults } from "../../ci/junitIngest.js";
import type { RunnerHandle } from "../../contracts/allocator.js";
import type { CommandSubstrate } from "../../contracts/commandSubstrate.js";
import type { EventStore } from "../../eventStore.js";
import { readWorkspaceFile, type FileAbsence } from "./harvestStepEvidence.js";

export interface IngestGateJunitInput {
  ssh: CommandSubstrate;
  target: RunnerHandle;
  workspacePath: string;
  /** The ambient-org-scoped client the per-test `ci_test_results` INSERT runs on (a data-plane table). */
  client: Pick<pg.Pool | pg.PoolClient, "query">;
  /**
   * The event store the `ci.tests.reported` append routes through — the run-state writer
   * (control plane) when remote-writes is on, else the in-process `PgEventStore`. The
   * data plane can no longer INSERT `events` directly (migration 0031), so the event
   * NEVER rides the de-privileged `client`.
   */
  eventStore: EventStore;
  runId: string;
  projectId: string;
  orgId: string;
  /** The commit the gate verified (the JUnit report is about this sha). */
  headSha: string;
  /** The gate's combined pass/fail — recorded as the test-step exit-code guard. */
  gatePassed: boolean;
  /**
   * The tier whose JUnit report this ingest reads (e.g. "slow" / "merge"). Carried
   * onto the loud `report_missing` signal so an operator sees WHICH tier emitted no
   * report. Absent ⇒ "unknown" in the signal.
   */
  tier?: string;
  /**
   * Did an executed gate tier DECLARE a `junitReport` path? Derived at the call site
   * from the resolved CI config (the EXPLICIT contract field, not a command sniff).
   * When TRUE, an absent/unreadable/empty report is a LOUD, durable signal
   * (flaky-intelligence is blind). When FALSE, an absent report is the expected quiet
   * no-op (no tier declared a report at this lifecycle point).
   */
  expectReport: boolean;
  /**
   * The workspace-relative path the declared junit-producing step writes its report to
   * (the `junitReport` field). Read back over SSH after the gate runs. Absent ⇒ no tier
   * declared a report (`expectReport=false`) and the read is skipped entirely.
   */
  reportPath?: string;
  /**
   * A pre-parsed JUnit report produced earlier in the same gate evaluation (the
   * evidence harvester reads + parses the report BEFORE the verdict so it can fail
   * the step on insufficient evidence). When present, the ingest skips its own SSH
   * read + parse and reuses this report — no double-read over SSH. When absent (the
   * pre-evidence call sites: tests, future call sites), the ingest reads + parses
   * itself. Optional; back-compat preserved.
   */
  preParsedReport?: JunitReport;
}

// Why the runner produced no usable JUnit report. Discriminated so the loud signal
// names the actual cause instead of collapsing them to "no report". Aliased to the
// shared `FileAbsence` from {@link readWorkspaceFile} so the absent/read_failed/empty
// vocabulary is the single SSH-read primitive both the harvester + ingest agree on.
type ReportAbsence = FileAbsence;

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
  // No tier declared a junitReport path ⇒ nothing to read; clean QUIET no-op.
  if (!input.expectReport || input.reportPath === undefined) {
    return { kind: "skipped_no_test_step" };
  }
  // EVIDENCE-REUSE (apex v57 task #64): when the gate's evidence harvester already
  // read + parsed the JUnit report in this same gate evaluation, reuse it (no
  // double-read over SSH). Otherwise the ingest reads + parses itself — preserving
  // the back-compat path for callers / tests that bypass the harvester.
  let report: JunitReport;
  if (input.preParsedReport === undefined) {
    const read = await readWorkspaceFile(
      { ssh: input.ssh, target: input.target, workspacePath: input.workspacePath },
      input.reportPath,
    );
    if (!read.present) {
      // A report WAS declared but is missing/unreadable/empty — the LOUD durable case.
      return { kind: "missing_expected", reason: read.reason };
    }
    report = parseJunitReport(read.contents);
  } else {
    report = input.preParsedReport;
  }
  const result = await ingestJunitResults({
    client: input.client,
    eventStore: input.eventStore,
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
