import { z } from "zod";

// P2e-1 (autonomy-engine.md §2d "Reaching Mergify parity → removing it
// entirely"): flaky-test detection + auto-quarantine. Tanren already records
// per-run CI observations (ci.passed / ci.failed, each carrying the per-check
// `checkRuns[]` and the `headSha`). The flaky detector reduces those
// observations across runs/attempts and flags a CHECK that is DEMONSTRABLY
// non-deterministic — it both PASSED and FAILED on the SAME head SHA (same
// code, different result), or it failed then passed on retry on the same SHA.
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

/** The non-determinism evidence shared by both flaky events. */
const FlakyEvidence = z
  .object({
    /** The check/test name that toggled outcome (the GitHub check run name). */
    checkName: z.string().min(1),
    /**
     * The number of DISTINCT head SHAs on which this check was observed to BOTH
     * pass and fail (the genuine-non-determinism count). Always ≥ 1 — the
     * detector never fires on a single outcome.
     */
    toggledShaCount: z.number().int().positive(),
    /** Total CI observations of this check across the window (pass + fail). */
    observationCount: z.number().int().positive(),
    /** Passes-on-retry: the check failed then passed on the SAME head SHA. */
    passedOnRetryCount: z.number().int().nonnegative(),
    /** A sample of the head SHAs that exhibited the toggle (capped, for triage). */
    sampleShas: z.array(z.string()),
  })
  .strict();

export const CiFlakyDetectedPayload = FlakyEvidence;

export const CiTestQuarantinedPayload = FlakyEvidence.extend({
  /** The quarantine-surface row id recorded for this check. */
  quarantineId: z.string().min(1),
}).strict();
