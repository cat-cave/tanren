// rv-21 — shared complete-capture EXTRAS for the derive tests.
//
// The derive boundary now enforces the deterministic interview-completion predicate: a
// capture may only derive once it carries an identity, ≥1 persona, ≥1 Given/When/Then
// behavior whose persona resolves, ≥1 interface, an explicit design seed, architecture,
// and lifecycle. Every derive fixture spreads these EXTRAS (the non-lifecycle/non-design
// areas) so a test isolating a LATER guard (deploy/JIT/rollback/idempotency) passes
// completeness first and reaches the guard under test. A test exercising the completeness
// gate itself omits an area explicitly.

/* eslint-disable unicorn/no-thenable -- Given/When/Then is the captured behavior vocabulary. */
const COMPLETE_CAPTURE_EXTRAS = {
  identity: { slug: "supply-chain-os", pitch: "supply chain operations for mid-market manufacturers", repoHint: "" },
  personas: [{ name: "operator", description: "runs the product day to day", surface: "desktop" }],
  behaviors: [
    {
      persona: "operator",
      title: "inspect status",
      given: "a running product",
      when: "the operator opens status",
      then: "the current status is visible",
    },
  ],
  interfaces: [{ name: "desktop dashboard", note: "operator surface" }],
  architecture: [{ layer: "web", choice: "next.js · turborepo" }],
} as const;
/* eslint-enable unicorn/no-thenable */

/** The non-lifecycle/non-design capture areas the completion predicate requires, as a
 * fresh (deeply-cloned) object each call so a test may mutate the returned capture. */
export function completeCaptureExtras(): {
  identity: { slug: string; pitch: string; repoHint: string };
  personas: Array<{ name: string; description: string; surface: string }>;
  behaviors: Array<{ persona: string; title: string; given: string; when: string; then: string }>;
  interfaces: Array<{ name: string; note: string }>;
  architecture: Array<{ layer: string; choice: string }>;
} {
  return structuredClone(COMPLETE_CAPTURE_EXTRAS) as ReturnType<typeof completeCaptureExtras>;
}
