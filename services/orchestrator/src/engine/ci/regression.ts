// THE REGRESSION CONTRACT — the per-iteration test judgment.
//
// THE PROBLEM. The per-iteration gate (`fast` / `per_iteration`) is the ONLY gate that
// runs inside the writer's own loop, and it is the only place a failure is fed back to
// the writer AS STEERING in the context that produced it (`gateReason`, subtaskInnerLoop).
// Every real project excludes tests from it, and the stated reason is never cost — it is
// that A WRITER MID-FEATURE HAS A LEGITIMATELY RED SUITE. Blocking every iteration on
// absolute redness converts the loop into a thrash, so tests get deferred to `pre_audit`
// — and the writer only learns it broke something A ROUND LATER, as a verdict, after the
// context that made the edit is gone. It then remediates blind.
//
// THE OBSERVATION. "Red" conflates two mechanically distinguishable things:
//
//   1. Tests the writer is CURRENTLY AUTHORING. Red mid-iteration is correct and
//      expected; blocking on it IS thrash.
//   2. Pre-existing tests the writer BROKE. Green at the run's base, red now. Blocking
//      on these is never thrash — it is precisely the signal the loop is missing.
//
// A REGRESSION CONTRACT separates them without a heuristic: compare the step's JUnit
// report against a BASELINE captured from the untouched base tree, and fail ONLY on a
// pass→fail TRANSITION. That single rule dissolves all three objections that kept tests
// out of the per-iteration gate:
//
//   - THRASH        — a test the writer just authored is not in the baseline, so it can
//                     never regress. The writer is never blocked on its own in-progress work.
//   - `minTests`    — a regression contract is vacuously satisfied when zero tests run, so
//                     the per-iteration tier needs no floor. The real floors stay at
//                     `pre_audit`/`pre_merge`, where the suite is never scoped and
//                     "zero tests ran" remains a genuine defect.
//   - GREENFIELD    — a scaffold has no baseline-passing tests, so nothing can regress.
//                     The upstream default's rationale ("tests arrive with features, so a
//                     scaffold pass is never blocked by a test tier") is satisfied by
//                     construction rather than by excluding tests.
//
// WHY NOT IMPACTED-TEST SELECTION. The obvious cheaper alternative — run only the tests
// related to the changed files — was measured against the real failure this contract was
// built for and REJECTED. Two findings killed it. First, COLLECTION IS 59% OF THE COST
// (10.2s of a 17.4s 12,188-test suite), so every strategy that still hands the runner the
// full test roots pays nearly the whole bill; only explicit path selection is actually
// cheap, and that is the fragile kind. Second, and decisively, IT UNDER-SELECTS ON THE
// EXACT BUG: of 12 broken tests, only 6 were in the reverse-dependency set of the file the
// writer was working in; the other 6 had a different root cause in a file outside it, and
// were reached by an import closure only by accident via a re-exporting `__init__`. A
// selector that misses half the breakage it was built to catch is worse than no selector.
// So this contract does NOT scope the suite. It runs the whole thing and scopes the
// JUDGMENT instead — which costs nothing extra and cannot under-select.
//
// STACK-AGNOSTIC: this module compares parsed JUnit reports by test id. It names no test
// runner, no language, no selection tool. Tanren declares the contract; the project's own
// `run` command produces the report.

import type { JunitReport } from "./junit.js";

/**
 * The set of test ids that PASSED on the untouched base tree — the only outcome a
 * regression can be measured against.
 *
 * Deliberately NOT "every test in the baseline report": a test that was already failing
 * (or erroring, or skipped) at base cannot REGRESS. Folding those in would re-import the
 * absolute-redness judgment this contract exists to avoid — a run started on a
 * base-branch tip with three pre-existing failures (a real, measured condition) would
 * block the writer on breakage it did not cause.
 */
export interface RegressionBaseline {
  /** Test ids observed with outcome `passed` on the base tree. */
  readonly passing: ReadonlySet<string>;
  /** Total cases in the baseline report — carried for the observability payload. */
  readonly total: number;
}

/**
 * Project a baseline report into the passing-test set. `skipped` is excluded along with
 * `failed`/`error`: a test skipped at base has no green state to lose, and runners skip
 * for environment reasons that vary between the prep run and the gate run.
 */
export function baselineFromReport(report: JunitReport): RegressionBaseline {
  const passing = new Set<string>();
  for (const result of report.results) {
    if (result.outcome === "passed") passing.add(result.testId);
  }
  return { passing, total: report.total };
}

/**
 * The regressed test ids: every test that PASSED in the baseline and is now `failed` or
 * `error`. Sorted for a stable, dedupe-friendly steering string and a deterministic
 * event payload.
 *
 * TWO DELIBERATE NON-REGRESSIONS, both of which keep the contract honest:
 *
 *   - A test ABSENT from the current report is NOT a regression. Writers legitimately
 *     delete, rename and re-parametrize tests, and a rename is indistinguishable from a
 *     deletion at the id level. Treating disappearance as breakage would fire on ordinary
 *     refactors — the false-positive class that makes a gate get switched off. Mass
 *     disappearance (a collection error dropping a whole root) is a real failure mode, but
 *     it is the `minTests` evidence floor's job at `pre_audit`/`pre_merge`, where the suite
 *     is unscoped and a shortfall is unambiguous. This contract judges TRANSITIONS ONLY.
 *   - A test failing that is NOT in the baseline is NOT a regression — that is case (1),
 *     the writer's own in-progress work, and blocking on it is the thrash this exists to
 *     prevent.
 */
export function detectRegressions(baseline: RegressionBaseline, report: JunitReport): string[] {
  const regressed: string[] = [];
  for (const result of report.results) {
    if (result.outcome !== "failed" && result.outcome !== "error") continue;
    if (!baseline.passing.has(result.testId)) continue;
    regressed.push(result.testId);
  }
  // Default `sort()` compares by UTF-16 code units — deterministic and locale-independent,
  // which is what the convergence detector needs (an unstable order would read as new
  // information every iteration). No custom comparator: the input is already de-duplicated,
  // so one could only re-specify what the default already does.
  return [...new Set(regressed)].sort();
}

/**
 * The CONFIRMED regressions across two independent runs of the same step — the
 * intersection.
 *
 * WHY THIS EXISTS. Test suites flake, and a flake is indistinguishable from a regression
 * in a single report: both are "green at base, red now". This is not hypothetical — the
 * repository this contract was designed against applies a repo-wide 100ms per-test
 * wall-clock budget, and its own measurements record a ~25% PER-RUN flake rate on an
 * otherwise idle host, every failure a timeout rather than a logic error. Steering a
 * writer to "fix" a test that is not broken is worse than saying nothing: it burns an
 * iteration, pollutes the convergence detector's failure signature, and teaches the
 * writer to distrust the gate.
 *
 * So a regression is only reported when it reproduces. The confirmation run is on the
 * FAILURE PATH ONLY — it costs nothing on the overwhelmingly common green iteration, and
 * it is paid exactly where precision matters most, immediately before the loop spends a
 * writer call on the result.
 */
export function confirmRegressions(first: readonly string[], second: readonly string[]): string[] {
  const secondSet = new Set(second);
  return first.filter((testId) => secondSet.has(testId));
}

/**
 * Cap on the test ids carried in the gate event payload and named in the writer's
 * steering. A whole-root breakage can regress thousands of tests; the names stop being
 * informative long before then, and both the events table and the writer's context window
 * are finite. The true count always rides alongside the sample.
 */
export const MAX_NAMED_REGRESSIONS = 25;

/** Bound a regression list to the reportable sample (already sorted by `detectRegressions`). */
export function sampleRegressions(regressed: readonly string[]): string[] {
  return regressed.slice(0, MAX_NAMED_REGRESSIONS);
}

/**
 * The writer-facing steering body for a confirmed regression set. Names the tests, states
 * the contract that was violated, and — critically — tells the writer what NOT to do.
 *
 * The last sentence is the load-bearing one. A writer told only "these tests fail" has two
 * available moves: fix the code, or edit the tests. The failure this contract was built
 * from is exactly the case where editing the tests is the WRONG move and the tempting one
 * — pre-existing tests stub an ordered sequence of calls, the writer reordered the calls,
 * and "make the test expect the new order" reads like a fix. It is not; it deletes the
 * assertion that caught the change. The observed remediation attempt in that run turned 1
 * failure into 12. So the directive names the diagnosis (these were green before YOUR
 * change) and the correct move (fix the code, or justify the test edit explicitly).
 *
 * @param sample       the bounded, sorted test ids to name
 * @param totalCount   the TRUE number of confirmed regressions (>= sample.length)
 * @param baselineTotal cases in the baseline report, for scale
 */
export function describeRegressions(sample: readonly string[], totalCount: number, baselineTotal: number): string {
  const list = sample.map((testId) => `  - ${testId}`).join("\n");
  const remainder = totalCount - sample.length;
  const more = remainder > 0 ? `\n  …and ${remainder} more` : "";
  return (
    `TEST REGRESSION [gate-test-regression]: ${totalCount} test(s) that PASSED on this run's ` +
    `base tree (${baselineTotal} cases) now FAIL. These are NOT tests you are in the middle of ` +
    `writing — they were green before your change and your change broke them:\n${list}${more}\n` +
    `The failure reproduced across two runs, so it is not a flake. Fix the code that broke them. ` +
    `Do NOT edit these tests to match your new behaviour unless you can state why the OLD assertion ` +
    `was wrong — rewriting a test to accept what you just changed deletes the check that caught you.`
  );
}
