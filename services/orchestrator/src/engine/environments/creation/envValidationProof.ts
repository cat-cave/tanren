// Environment management (environment-management.md §4 + §7 P4) — the ENV-IMAGE
// validation verdict, the env-layer counterpart of `templates/validationProof.ts`.
// The validation harness (./envValidationHarness.ts) produces an
// `EnvironmentValidationProof` (the canonical manifest shape); THIS module is the
// single "the env is genuinely isolated + working, not green-by-accident" predicate
// every consumer reads over a produced proof.
//
// WHY the negative controls are non-optional (the env-layer of the v29 lesson): a
// positive smoke alone ("every declared tool resolves to its locked version") does
// NOT prove the env is ISOLATED. The golden base ships a warm baseline (node/pnpm/
// python/go); an off-baseline env that FROMs it could silently inherit those — a
// "python 3.11 env" that still resolves a stray baseline `node` is a LEAKED env, not
// an isolated one. The negative controls catch exactly this: an UNDECLARED tool must
// be ABSENT and a WRONG/forbidden version must NOT resolve. An env whose isolation
// control is `unproven` (the leak was NOT caught) FAILS validation, exactly as a
// template with an unproven negative control does.

import type { EnvironmentValidationProof } from "../manifest.js";

/**
 * THE env verdict predicate every consumer reads. An env-image VALIDATES iff:
 *   1. the POSITIVE smoke passed (bootstrap + every DECLARED tool resolved to its
 *      LOCKED version, exit 0), AND
 *   2. BOTH isolation negative controls are `proven`:
 *      - `undeclaredToolAbsent` — an undeclared tool is genuinely ABSENT (no
 *        golden-base leakage), AND
 *      - `forbiddenVersionAbsent` — a wrong/forbidden version is NOT resolvable.
 *
 * A control that is `unproven` (the isolation defect was NOT caught — the env leaked)
 * or `"n/a"` (the control did not run — never silently treated as a pass) BLOCKS
 * validation. PURE: callers test the verdict deterministically without re-running the
 * harness — the publish gate (`createEnvironment`) reads exactly this.
 */
export function environmentValidates(proof: EnvironmentValidationProof): boolean {
  if (!proof.positiveSmokePassed) {
    return false;
  }
  // BOTH isolation controls must be `proven` — an env's whole point is isolation, so
  // an `unproven`/`n/a` isolation control is a hard failure (never a quiet pass).
  return (
    proof.negativeControls.undeclaredToolAbsent === "proven" &&
    proof.negativeControls.forbiddenVersionAbsent === "proven"
  );
}
