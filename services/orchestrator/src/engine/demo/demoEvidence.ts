// Demos-as-evidence — the evidence MODEL (design doc § "Native Deployment And
// Demos": demos are first-class behavior evidence tied to the spec's BEHAVIORS, not
// to the provider). This file owns the verifiable artifact a demo produces, kept
// separate from the engine orchestration so the engine file stays under the
// dependency/line caps.
//
// The unit of demo evidence is PER BEHAVIOR: a demo does not assert "the app
// deployed" — it asserts a per-behavior verdict plus the captured detail of WHAT was
// exercised. That per-behavior verdict is what makes a demo EVIDENCE (verifiable)
// rather than narration (prose). The narration layer (narration.ts) summarizes this
// evidence; it never replaces it.
//
// rv-18: a WEB behavior's verdict is the REAL rv-11 acceptance outcome (the product's
// declared behavior executed against the live release URL via the rv-6 HTTP driver),
// produced by ProofBackedWebDemo — NOT a `/`-reachability status. The naive
// per-behavior HTTP-reachability probe that lived here is removed. The non-web arms
// (package / download / app_channel) produce their own real observations.
//
// NON-SECRET by construction: a `BehaviorEvidence` carries only the behavior id, the
// surface kind, the outcome, and a human detail string (e.g. "acceptance passed: 2/2
// assertions passed"). It NEVER carries a token, a credential ref, or a response body —
// only the observable shape of the reach.

import type { DemoSurface } from "../contracts/deployAdapter.js";

/** The outcome of exercising one behavior against a demo surface. */
export type BehaviorEvidenceOutcome = "passed" | "failed";

/**
 * The verifiable evidence one behavior produced against the deployed surface. This
 * is the demo's load-bearing artifact: a per-behavior verdict plus a captured,
 * human-readable detail of WHAT was exercised and what came back. Non-secret —
 * `detail` is an observable shape ("acceptance passed: 2/2 assertions passed"), never
 * a body/token.
 */
export interface BehaviorEvidence {
  /** The behavior this evidence is FOR (the spec behavior / behavior-revision id — ties evidence to behavior). */
  behaviorId: string;
  /** The behavior's human title (carried for the narration summary; non-secret). */
  behaviorTitle: string;
  /** The surface kind the behavior was exercised against (e.g. "web_url"). */
  surfaceKind: DemoSurface["kind"];
  /** Whether the behavior was successfully exercised on the live surface. */
  outcome: BehaviorEvidenceOutcome;
  /** A captured, human-readable detail of the exercise. Non-secret. */
  detail: string;
}
