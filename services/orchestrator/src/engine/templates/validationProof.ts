// The VALIDATION PROOF VERDICT — the single "meaningful, not green-by-accident"
// pass/fail predicate (`templateValidates`) callers read over a produced proof. A
// template is a conforming repo (a `justfile` with `bootstrap`/`tier-1..3`/`build`/
// `deploy` + a `.tanren/ci.yml`, see docs/operator-guide/ci-config.md); the
// validation harness (`./validationHarness.ts`) produces the proof, this module
// decides whether it passes.
//
// WHY this exists (the v29 lesson): apex v29's fixture shipped a `tsc --noEmit` on a
// solution tsconfig with an EMPTY `files` array — it PASSED while checking ZERO
// files, a no-op typecheck. A "positive controls all green" template would have
// published that broken gate. The proof's NEGATIVE controls catch exactly this: a
// gate that PASSES despite a planted defect is `unproven`, and a template with any
// declared-but-`unproven` control FAILS validation.
//
// THE PROOF SHAPE IS CANONICAL (wave-1 unification): the proof type is
// `TemplateValidationProof` from `./manifest.js` (the `validationProof` field of
// `TemplateManifestV1`) and each per-gate verdict is `NegativeControlResult`
// (`proven`/`unproven`/`"n/a"`). This module imports those — there is NO local proof
// type — so the harness output is assignable to `TemplateManifestV1.validationProof`
// directly (the whole point of the unification).

import type { TemplateValidationProof } from "./manifest.js";
import type { NegativeControlCapability } from "./negativeControls.js";

// The per-capability negative-control verdict is the canonical `NegativeControlResult`
// from the manifest schema (re-exported from this barrel via manifest.ts):
//   - "proven":   the gate CAUGHT the planted defect (it failed as it must).
//   - "unproven": the gate PASSED despite the planted defect — a no-op gate (the v29
//                 failure mode). A DECLARED control that lands here FAILS validation.
//   - "n/a":      the capability is not declared by this template (nothing to prove).
// There is no "skipped"/"unknown": a control that cannot run is a LOUD "unproven",
// never a quiet pass.

// The capability keys carried on the proof's `negativeControls`. A 1:1 mirror of the
// `NegativeControlCapability` union so adding a capability is a single-point change
// the type checker enforces across the harness, the injectors, and the predicate.
export const NEGATIVE_CONTROL_CAPABILITIES: ReadonlyArray<NegativeControlCapability> = Object.freeze([
  "typecheck",
  "lint",
  "test",
  "mutation",
]);

// THE verdict predicate every consumer reads. A template VALIDATES iff:
//   1. positive controls all passed (bootstrap + tiers + build), AND
//   2. every DECLARED negative control is "proven" — a declared control that is
//      "unproven" (a no-op gate, the v29 scenario) FAILS validation; an "n/a"
//      (undeclared) control does NOT block, AND
//   3. the auditor is clean (no open P0/P1).
// PURE: callers test the verdict deterministically without re-running the harness.
export function templateValidates(proof: TemplateValidationProof): boolean {
  if (!proof.positiveControlsPassed || !proof.auditorClean) {
    return false;
  }
  // A declared-but-unproven control is the hard failure. "n/a" (undeclared) and
  // "proven" both pass; only "unproven" blocks.
  return NEGATIVE_CONTROL_CAPABILITIES.every((capability) => proof.negativeControls[capability] !== "unproven");
}
