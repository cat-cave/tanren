// CI-intelligence PR2: per-TEST flaky detection + duration profiling over the
// `ci_test_results` history (the JUnit-ingested per-test rows PR1 landed). This
// is the per-test analogue of the check-level `deriveFlakyTests` (ciFlaky.ts):
// the same toggled-sha + passes-on-retry math + the SAME safety gate (a
// consistently-failing test is NEVER flagged), now keyed on `test_id`.
//
// CRITICAL SAFETY — identical to the check-level detector:
//   - A test is flaky ONLY when it BOTH passed AND failed on the SAME head SHA
//     (same code, different result), OR it carried an intra-run retry/flakyFailure
//     (a fail-then-pass WITHIN one run — Surefire reruns / vitest retries). A
//     cross-run toggle must be observed on at least `minToggledShas` distinct SHAs.
//   - A test that ONLY ever fails (across every SHA, no intra-run recovery) is a
//     CONSISTENT failure — genuinely broken — and is NEVER flagged or quarantined.
//
// Duration profiling derives per-test p50/p95 and a slow signal (a test whose p95
// exceeds an absolute threshold OR regresses past a multiple of its trailing
// baseline). This is observation-only — it never feeds the merge gate; only the
// flaky verdict actuates a quarantine.

/** One persisted `ci_test_results` row, normalized for the reducers. Pure input. */
export interface CiTestObservation {
  testId: string;
  file: string | null;
  suite: string | null;
  headSha: string;
  /** Normalized DB outcome. `error` is treated as a failure for flaky math. */
  outcome: "passed" | "failed" | "error" | "skipped";
  durationMs: number | null;
  /** Intra-run retries recorded for this row (Surefire reruns / vitest retries). */
  retries: number;
  /** The observation-order anchor (`observed_at`), for passes-on-retry ordering. */
  observedAt: Date;
}

/** The non-determinism verdict for a single flaky TEST. */
export interface FlakyTestVerdict {
  testId: string;
  file: string | null;
  suite: string | null;
  /** Distinct head SHAs on which the test BOTH passed and failed cross-run. */
  toggledShaCount: number;
  /** Total observations of this test (every outcome) across the window. */
  observationCount: number;
  /** Rows that recorded an intra-run fail-then-pass (retry/flakyFailure) recovery. */
  intraRunFlakyCount: number;
  /** A capped sample of the toggling SHAs, for operator triage. */
  sampleShas: string[];
}

/** Per-test duration profile: the latency distribution + a slow/regression flag. */
export interface TestDurationProfile {
  testId: string;
  suite: string | null;
  /** Median duration (ms) across observations carrying a duration. */
  p50Ms: number;
  /** 95th-percentile duration (ms). */
  p95Ms: number;
  /** Observations that carried a non-null duration. */
  sampleCount: number;
  /** True when p95 breaches the absolute slow threshold OR regresses vs baseline. */
  slow: boolean;
}

const MAX_SAMPLE_SHAS = 5;

function isFailureOutcome(outcome: CiTestObservation["outcome"]): boolean {
  return outcome === "failed" || outcome === "error";
}

/**
 * Pure per-test flaky reducer. Groups observations by `test_id`, then by head SHA.
 * A test is flaky iff EITHER it both passed AND failed on the same SHA on at least
 * `minToggledShas` distinct SHAs (cross-run toggle), OR it carried an intra-run
 * retry/flakyFailure recovery (a fail-then-pass within one run). A test that only
 * ever fails on every SHA — with no intra-run recovery — yields NO verdict.
 * Deterministic over its inputs.
 */
export function deriveFlakyTestsPerTest(
  observations: ReadonlyArray<CiTestObservation>,
  options: { minToggledShas?: number } = {},
): FlakyTestVerdict[] {
  const minToggledShas = options.minToggledShas ?? 1;

  const byTest = new Map<string, CiTestObservation[]>();
  for (const obs of observations) {
    const list = byTest.get(obs.testId) ?? [];
    list.push(obs);
    byTest.set(obs.testId, list);
  }

  const verdicts: FlakyTestVerdict[] = [];
  for (const [testId, rows] of byTest) {
    const bySha = new Map<string, CiTestObservation[]>();
    for (const row of rows) {
      const list = bySha.get(row.headSha) ?? [];
      list.push(row);
      bySha.set(row.headSha, list);
    }

    let toggledShaCount = 0;
    let intraRunFlakyCount = 0;
    const sampleShas: string[] = [];
    for (const [headSha, shaRows] of bySha) {
      const passed = shaRows.some((r) => r.outcome === "passed");
      const failed = shaRows.some((r) => isFailureOutcome(r.outcome));
      // A toggle on ONE sha = a pass AND a fail on UNCHANGED code.
      if (passed && failed) {
        toggledShaCount += 1;
        if (sampleShas.length < MAX_SAMPLE_SHAS) sampleShas.push(headSha);
      }
    }
    // Intra-run flake: a row that recovered within a single run (retries > 0 with a
    // passing outcome) — Surefire flakyFailure / vitest retry. PR1 records `retries`.
    for (const row of rows) {
      if (row.retries > 0 && row.outcome === "passed") intraRunFlakyCount += 1;
    }

    // SAFETY GATE: a test is flaky ONLY with a genuine cross-run toggle on enough
    // SHAs OR a proven intra-run recovery. A consistently-failing test (every row a
    // failure, never an intra-run recovery) has toggledShaCount 0 AND
    // intraRunFlakyCount 0, so it is NEVER returned.
    const crossRunFlaky = toggledShaCount >= minToggledShas;
    if (crossRunFlaky || intraRunFlakyCount > 0) {
      const first = rows[0];
      verdicts.push({
        testId,
        file: first?.file ?? null,
        suite: first?.suite ?? null,
        // A purely intra-run flake still records its true (possibly 0) toggle count;
        // the active-quarantine floor is enforced by the recorder (>= 1).
        toggledShaCount: Math.max(toggledShaCount, crossRunFlaky ? toggledShaCount : 1),
        observationCount: rows.length,
        intraRunFlakyCount,
        sampleShas,
      });
    }
  }

  verdicts.sort((a, b) => b.toggledShaCount - a.toggledShaCount || a.testId.localeCompare(b.testId));
  return verdicts;
}

/** Inclusive-rank percentile over a sorted ascending array. Pure. */
function percentile(sortedAsc: ReadonlyArray<number>, fraction: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] ?? 0;
  const rank = fraction * (sortedAsc.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  const lo = sortedAsc[lower] ?? 0;
  const hi = sortedAsc[upper] ?? lo;
  return Math.round(lo + (hi - lo) * weight);
}

export interface DurationProfileOptions {
  /** Absolute p95 threshold (ms) above which a test is flagged slow. */
  slowP95Ms?: number;
  /** Trailing-baseline regression multiple: p95 over (baseline median × this) is slow. */
  regressionMultiple?: number;
  /** Minimum durations a test needs before a slow flag is meaningful. */
  minSamples?: number;
}

const DEFAULT_SLOW_P95_MS = 30_000;
const DEFAULT_REGRESSION_MULTIPLE = 3;
const DEFAULT_MIN_SAMPLES = 5;

/**
 * Pure per-test duration profiler. For each test it computes p50/p95 over the
 * observations carrying a duration, and flags `slow` when p95 breaches the
 * absolute threshold OR regresses past `regressionMultiple` × the trailing-baseline
 * median (the median of all-but-the-most-recent observation, observed-order). A
 * test with fewer than `minSamples` durations is never flagged (insufficient signal).
 */
export function deriveTestDurationProfiles(
  observations: ReadonlyArray<CiTestObservation>,
  options: DurationProfileOptions = {},
): TestDurationProfile[] {
  const slowP95Ms = options.slowP95Ms ?? DEFAULT_SLOW_P95_MS;
  const regressionMultiple = options.regressionMultiple ?? DEFAULT_REGRESSION_MULTIPLE;
  const minSamples = options.minSamples ?? DEFAULT_MIN_SAMPLES;

  const byTest = new Map<string, CiTestObservation[]>();
  for (const obs of observations) {
    if (obs.durationMs === null) continue;
    const list = byTest.get(obs.testId) ?? [];
    list.push(obs);
    byTest.set(obs.testId, list);
  }

  const profiles: TestDurationProfile[] = [];
  for (const [testId, rows] of byTest) {
    const ordered = [...rows].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
    const durations = ordered.map((r) => r.durationMs ?? 0);
    const sortedAsc = [...durations].sort((a, b) => a - b);
    const p50Ms = percentile(sortedAsc, 0.5);
    const p95Ms = percentile(sortedAsc, 0.95);

    let slow = false;
    if (durations.length >= minSamples) {
      const baseline = durations.slice(0, -1);
      const baselineSorted = [...baseline].sort((a, b) => a - b);
      const baselineMedian = percentile(baselineSorted, 0.5);
      const regressed = baselineMedian > 0 && p95Ms > baselineMedian * regressionMultiple;
      slow = p95Ms > slowP95Ms || regressed;
    }

    profiles.push({ testId, suite: ordered[0]?.suite ?? null, p50Ms, p95Ms, sampleCount: durations.length, slow });
  }

  profiles.sort((a, b) => b.p95Ms - a.p95Ms || a.testId.localeCompare(b.testId));
  return profiles;
}
