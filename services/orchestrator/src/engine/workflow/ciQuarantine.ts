// CI-intelligence PR2 — THE GATE READ + ACTUATION (the "ship" half). The flaky-
// quarantine surface (`quarantined_tests`) was OBSERVE-ONLY: written by the
// detector but never read by the merge gate, so a flaky→quarantine→ship loop
// NEVER closed — the gate kept RE-RUNNING the known-flaky step and kept red-
// gating the merge. This module is the read + actuation side:
//
//   1. `loadActiveQuarantine` — the PRODUCTION loader: it loads a project's ACTIVE
//      quarantine rows (org-scoped under RLS by the caller's client — a read off
//      the wrong scope sees ZERO rows) and projects them into two actuation keys:
//        - `checkNames` — the quarantined gate-STEP / forge-check names. The native
//          gate EXCLUDES a step in this set from the verdict (a quarantined step's
//          failure no longer fails the gate), and `evaluateCiObservation` excludes a
//          forge check in this set from `failingChecks`.
//        - `testIds` — the quarantined per-test ids. These are exported to the
//          project's test command via the STACK-AGNOSTIC `TANREN_QUARANTINE` env
//          (a comma-joined list) so a justfile/test runner that honors the
//          documented filter SKIPS exactly those tests. Tanren names NO stack: it
//          DECLARES the filter (the env), the project's contract HONORS it.
//
//   2. The actuation is what CLOSES the loop: with the quarantined step excluded
//      from the verdict, the gate can go GREEN while a root-cause spec is in flight,
//      and with `TANREN_QUARANTINE` exported the flaky test need not even run.
//
// CRITICAL SAFETY — this can NEVER mask a real regression: a row exists on this
// surface ONLY because the detector PROVED the check/test toggled (passed AND
// failed) on UNCHANGED code (or recovered intra-run). A consistently-failing
// (genuinely broken) check is never recorded, so its failure is never excluded
// here. The exclusion is by the stored `check_name` — for a per-test quarantine
// that is the test's owning suite/job, so a single flaky test's quarantine
// narrows to that check, not the whole gate.

import type pg from "pg";

// The env var the gate exports to the project's test command carrying the ACTIVE
// quarantined test ids (comma-joined). STACK-AGNOSTIC: Tanren declares this name;
// a project's `justfile` / test runner reads it to filter out the flaky tests
// (e.g. a vitest `--exclude`, a pytest deselect). Absent/empty ⇒ no filter.
export const QUARANTINE_ENV_VAR = "TANREN_QUARANTINE";

// Options for `evaluateCiObservation`. `quarantinedCheckNames` is the set of
// ACTIVE-quarantined check names: a failing check in this set is EXCLUDED from
// `failingChecks`, so a proven-flaky check failing no longer flips `status` to
// `failed`. SAFETY: a name lands here ONLY because the detector proved non-
// determinism on unchanged code (a consistently-failing check is never
// quarantined), so a real regression is never masked. Omitted ⇒ no exclusion.
export interface EvaluateCiObservationOptions {
  quarantinedCheckNames?: ReadonlySet<string>;
}

// A project's ACTIVE quarantine, projected into the two actuation keys the gate
// + the observation evaluator consume. Empty sets/array ⇒ no active quarantine
// (nothing excluded, no env exported) — the safe default.
export interface ActiveQuarantine {
  /** Quarantined gate-step / forge-check names — excluded from the verdict. */
  checkNames: ReadonlySet<string>;
  /** Quarantined per-test ids — exported via `TANREN_QUARANTINE` to skip them. */
  testIds: readonly string[];
}

interface ActiveQuarantineRow {
  check_name: string;
  test_id: string | null;
}

/**
 * Load a project's ACTIVE quarantine (the production loader). Org-scoped: the
 * caller passes a client already bound to the run's org scope (RLS denies by
 * default, so a read off the wrong scope sees ZERO rows). Returns the union of
 * the quarantined check names (for the verdict + observation exclusion) and the
 * quarantined test ids (for the `TANREN_QUARANTINE` env filter). A row with NO
 * `test_id` is a check-level quarantine; a row WITH one is per-test (and still
 * carries the owning check's name, so the step-level exclusion holds too).
 */
export async function loadActiveQuarantine(
  client: Pick<pg.Pool, "query">,
  projectId: string,
): Promise<ActiveQuarantine> {
  const result = await client.query<ActiveQuarantineRow>(
    `SELECT check_name, test_id
       FROM quarantined_tests
      WHERE project_id = $1 AND cleared_at IS NULL`,
    [projectId],
  );
  const checkNames = new Set<string>();
  const testIds: string[] = [];
  for (const row of result.rows) {
    if (row.check_name !== "") checkNames.add(row.check_name);
    if (row.test_id !== null && row.test_id !== "") testIds.push(row.test_id);
  }
  return { checkNames, testIds };
}

/**
 * Build the `TANREN_QUARANTINE` env entry for the gate's app-env, given the active
 * quarantine. The value is the comma-joined active test ids. Returns an EMPTY map
 * (no entry) when nothing is quarantined, so the gate command is unchanged in the
 * common case. The ids are filtered to those safe to carry in a single comma-joined
 * env value (see `isEnvSafeTestId`), a defensive guard since a test id originates
 * from the built repo's JUnit report.
 */
export function quarantineEnv(active: ActiveQuarantine): Record<string, string> {
  const safe = active.testIds.filter((id) => id !== "" && isEnvSafeTestId(id));
  if (safe.length === 0) return {};
  return { [QUARANTINE_ENV_VAR]: safe.join(",") };
}

/**
 * True when a test id is safe to carry in a single comma-joined env value: it has
 * NO comma (the join delimiter) and NO control character (code point < 0x20 —
 * newline/tab/null would break the env line). Ordinary spaces are KEPT (a real
 * JUnit test name routinely contains them). A char-code scan, not a control-char
 * regex, so the source carries no literal control bytes.
 */
function isEnvSafeTestId(id: string): boolean {
  for (const ch of id) {
    if (ch === "," || (ch.codePointAt(0) ?? 0) < 0x20) return false;
  }
  return true;
}
