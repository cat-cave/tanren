import { z } from "zod";

// Flaky-test detection + auto-quarantine (autonomy-engine.md §2d). Tanren derives
// flaky-test evidence from native `gate.verdict` observations across runs/attempts
// and flags a CHECK that is DEMONSTRABLY non-deterministic — it both PASSED and
// FAILED on the SAME head SHA (same code, different result), or it failed then
// passed on retry on the same SHA.
//
// A check that only ever fails (consistent failure → genuinely broken) is NOT
// flaky and is NEVER quarantined: quarantine ≠ ignore-all-failures. These two
// events make the detector's decision OPERATOR-VISIBLE so a quarantine can
// never silently mask a real failure:
//
//   - ci.flaky.detected   → the detector observed a check toggling outcome on
//                           unchanged code (the non-determinism evidence).
//   - ci.test.quarantined → that check was recorded on the quarantine surface
//                           (quarantined_tests). Operator-visible by design.

// The non-determinism evidence shared by both flaky events. CI-intelligence PR2
// adds the per-TEST grain: a quarantine is EITHER check-level (checkName only) or
// a single flaky TEST (testId set, with its file/suite). Both share the toggle +
// observation counts; the per-test fields are optional so a check-level event is
// unchanged.
const FlakyEvidence = z
  .object({
    /** The check/test name that toggled outcome (the GitHub check run name / suite). */
    checkName: z.string().min(1),
    /**
     * CI-intelligence PR2: the stable test id when this is a PER-TEST quarantine;
     * absent for a check-level quarantine. The merge gate actuates a per-test row
     * by this id while keeping the owning check job active.
     */
    testId: z.string().min(1).optional(),
    /** The test's source file, when this is a per-test quarantine and known. */
    file: z.string().nullable().optional(),
    /** The test's owning suite, when this is a per-test quarantine and known. */
    suite: z.string().nullable().optional(),
    /**
     * The number of DISTINCT head SHAs on which this check/test was observed to
     * BOTH pass and fail (the genuine-non-determinism count). Always ≥ 1 — the
     * detector never fires on a single outcome.
     */
    toggledShaCount: z.number().int().positive(),
    /** Total CI observations of this check/test across the window (pass + fail). */
    observationCount: z.number().int().positive(),
    /** Passes-on-retry: the check failed then passed on the SAME head SHA. */
    passedOnRetryCount: z.number().int().nonnegative().optional(),
    /** Per-test intra-run recoveries (a fail-then-pass within one run). */
    intraRunFlakyCount: z.number().int().nonnegative().optional(),
    /** A sample of the head SHAs that exhibited the toggle (capped, for triage). */
    sampleShas: z.array(z.string()),
  })
  .strict();

export const CiFlakyDetectedPayload = FlakyEvidence;

export const CiTestQuarantinedPayload = FlakyEvidence.extend({
  /** The quarantine-surface row id recorded for this check. */
  quarantineId: z.string().min(1),
}).strict();

// CI-intelligence ingestion (foundation): a JUnit report was uploaded from the
// generated repo's CI and parsed into per-test rows for a run. The payload is a
// SUMMARY only (counts + the head SHA + attempt) — never a secret value, never a
// test's stdout/stderr. Test names/files (which DO ride the persisted rows) are
// `public` like every other CI identifier; nothing secret is in this event.
export const CiTestsReportedPayload = z
  .object({
    /** The commit SHA the report was produced against (CI `github.sha`). */
    headSha: z.string(),
    /** The CI re-run attempt this report came from (GitHub `run_attempt`), ≥ 1. */
    attempt: z.number().int().positive(),
    /** Total `<testcase>` rows persisted from this report. */
    total: z.number().int().nonnegative(),
    /** Of those, how many were `failed` or `error`. */
    failures: z.number().int().nonnegative(),
    /** How many cases showed a fail-then-pass WITHIN this run (single-run flaky). */
    flaky: z.number().int().nonnegative(),
    /**
     * The test-step exit code the runner reported (the `--test-exit-code`
     * upload guard). A non-zero code with a clean-looking report flags a
     * runner-crash-after-write — recorded so a later phase never reads such a
     * report as "all green". Null when the uploader did not supply it.
     */
    testExitCode: z.number().int().nullable(),
  })
  .strict();

// CI-intelligence per-test grain WENT BLIND: a gate tier DECLARED a `junitReport` path
// (the explicit CI-config contract) and its test step ran, but the runner produced no
// usable report at that path (absent / unreadable / empty). The native ingest yields
// NO per-test rows for this gate, so flaky→quarantine→root-cause has no grain for it —
// a reporter misconfig or a runner crash AFTER the test step. DURABLE + LOUD (the
// no-silent-skip doctrine): advisory, NEVER merge-gating (the gate verdict already
// stands), but recorded so an operator can see WHICH tier/path went blind and why.
export const CiJunitMissingPayload = z
  .object({
    /** The commit the gate verified (the missing report would have been about this sha). */
    headSha: z.string(),
    /** The tier whose declared `junitReport` produced nothing (e.g. "slow" / "merge"). */
    tier: z.string().min(1),
    /** The declared workspace-relative report path the gate read back (and found empty). */
    reportPath: z.string().min(1),
    /** Why no usable report was found: the file was absent, the SSH read failed, or it was empty. */
    reason: z.enum(["absent", "read_failed", "empty"]),
  })
  .strict();
