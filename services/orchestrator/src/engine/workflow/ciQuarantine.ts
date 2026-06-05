// CI-intelligence PR2 — THE GATE READ (the actuation fix). The flaky-quarantine
// surface (`quarantined_tests`) was OBSERVE-ONLY: written by the detector but
// never read by the merge gate. This module is the read side: it loads a project's
// ACTIVE quarantine targets so `evaluateCiObservation` can EXCLUDE a quarantined
// check from `failingChecks` — a quarantined flaky check failing no longer flips
// the observation `status` to `failed`, so the merge queue stops blocking on it.
//
// CRITICAL SAFETY — this can NEVER mask a real regression: a row exists on this
// surface ONLY because the detector PROVED the check/test toggled (passed AND
// failed) on UNCHANGED code (or recovered intra-run). A consistently-failing
// (genuinely broken) check is never recorded, so its failure is never excluded
// here. The exclusion is by the stored `check_name` — for a per-test quarantine
// that is the test's owning suite/job, so a single flaky test's quarantine
// narrows to that check, not the whole gate.

// Options for `evaluateCiObservation`. `quarantinedCheckNames` is the set of
// ACTIVE-quarantined check names: a failing check in this set is EXCLUDED from
// `failingChecks`, so a proven-flaky check failing no longer flips `status` to
// `failed`. SAFETY: a name lands here ONLY because the detector proved non-
// determinism on unchanged code (a consistently-failing check is never
// quarantined), so a real regression is never masked. Omitted ⇒ no exclusion.
export interface EvaluateCiObservationOptions {
  quarantinedCheckNames?: ReadonlySet<string>;
}
