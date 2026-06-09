// The VALIDATION PROOF — the "meaningful, not green-by-accident" verdict a template
// must carry before it can publish. A template is a conforming repo (a `justfile`
// with `bootstrap`/`tier-1..3`/`build`/`deploy` + a `.tanren/ci.yml`, see
// docs/roadmap/stack-flexible-contract.md). This module defines the SHAPE of the
// proof the validation harness (`./validationHarness.ts`) produces and the single
// pass/fail predicate (`templateValidates`) callers read.
//
// WHY this exists (the v29 lesson): apex v29's fixture shipped a `tsc --noEmit` on a
// solution tsconfig with an EMPTY `files` array — it PASSED while checking ZERO
// files, a no-op typecheck. A "positive controls all green" template would have
// published that broken gate. The proof's NEGATIVE controls catch exactly this: a
// gate that PASSES despite a planted defect is `unproven`, and a template with any
// declared-but-`unproven` control FAILS validation.
//
// SEAM (wave-1 unification): docs/roadmap/templating-system.md §1 places the
// validation proof on a `TemplateManifestV1.validationProof`. Wave 1 (the registry +
// `.tanren/template.yml` metadata schema) is NOT merged yet, so this module defines a
// LOCAL `ValidationProof` matching the doc's shape. When the manifest type lands,
// re-export `ValidationProof` from there (or assert structural equality) and delete
// this local definition — the harness keeps producing the same shape either way.

import type { NegativeControlCapability } from "./negativeControls.js";

// The verdict of one negative control:
//   - "proven":   the gate CAUGHT the planted defect (it failed as it must).
//   - "unproven": the gate PASSED despite the planted defect — a no-op gate (the v29
//                 failure mode). A DECLARED control that lands here FAILS validation.
//   - "n/a":      the capability is not declared by this template (nothing to prove).
// There is no "skipped"/"unknown": a control that cannot run is a LOUD "unproven"
// (with the reason recorded), never a quiet pass.
export type NegativeControlVerdict = "proven" | "unproven" | "n/a";

// The per-capability negative-control results. Every declared-gate capability the
// doc names has a slot; an undeclared one is "n/a". `mutation` is "n/a" unless the
// template declares it (see docs/roadmap/templating-system.md §1: mutation is an
// OPTIONAL capability).
export interface NegativeControls {
  typecheck: NegativeControlVerdict;
  lint: NegativeControlVerdict;
  test: NegativeControlVerdict;
  mutation: NegativeControlVerdict;
}

// The full validation proof for a template, matching docs/roadmap/templating-system.md
// §1's shape. `validatedAt` is an ISO-8601 timestamp from a PASSED-IN clock (Date.now
// is unavailable in some execution contexts — the harness takes `now` as a param) and
// `validatedSha` is the template commit the proof was produced against, so a stale
// proof (the template moved on) is detectable downstream (the §4 maintenance/freshness
// logic re-runs the harness on every bump).
export interface ValidationProof {
  // POSITIVE controls: `just bootstrap` then each declared tier + `build` all passed.
  positiveControlsPassed: boolean;
  // NEGATIVE controls: the planted-defect results (the core proof).
  negativeControls: NegativeControls;
  // The spec-loop auditor found no open P0/P1 over the template.
  auditorClean: boolean;
  // ISO-8601, from the passed-in clock.
  validatedAt: string;
  // The template commit SHA this proof was produced against.
  validatedSha: string;
}

// The capability keys carried on `NegativeControls`. A 1:1 mirror of the
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
export function templateValidates(proof: ValidationProof): boolean {
  if (!proof.positiveControlsPassed || !proof.auditorClean) {
    return false;
  }
  // A declared-but-unproven control is the hard failure. "n/a" (undeclared) and
  // "proven" both pass; only "unproven" blocks.
  return NEGATIVE_CONTROL_CAPABILITIES.every((capability) => proof.negativeControls[capability] !== "unproven");
}
