import { z } from "zod";

// Demos-as-evidence event schemas (design doc § "Native Deployment And Demos":
// demos are first-class behavior evidence tied to the spec's BEHAVIORS, not the
// provider). After a merged run's deploy is VERIFIED, the demo engine exercises each
// of the spec's behaviors against the deployed SURFACE and records evidence PER
// behavior. These events are that evidence + its summary.

// demo.evidence.recorded ("a behavior was exercised on the live surface"): the
// verifiable per-behavior verdict. Records WHICH behavior, the surface KIND it was
// exercised against, the OUTCOME, and a captured human DETAIL of the exercise (e.g.
// "GET /links → HTTP 200"). SECURITY: every field is non-secret — a behavior id, a
// surface kind, an outcome, and the OBSERVABLE SHAPE of the reach; never a token, a
// credential ref, or a response body.
export const DemoEvidenceRecordedPayload = z
  .object({
    /** The spec behavior this evidence is FOR (ties evidence to the behavior, not the provider). */
    behaviorId: z.string(),
    /** The behavior's human title (carried for the operator summary). */
    behaviorTitle: z.string(),
    /** The surface kind the behavior was exercised against (e.g. "web_url"). */
    surfaceKind: z.string(),
    /** Whether the behavior was successfully exercised on the live surface. */
    outcome: z.enum(["passed", "failed"]),
    /** The captured, human-readable detail of the exercise ("GET /links → HTTP 200"). Non-secret. */
    detail: z.string(),
  })
  .strict();

// demo.completed ("the demo finished"): the summary across all of the spec's
// behaviors — the surface kind, how many behaviors were exercised, and the pass/fail
// tally. A demo with zero behaviors records this with zero counts (the operator sees
// the demo ran + found nothing to exercise) — never a silent no-op. SECURITY: counts
// + a surface-kind string; nothing secret.
export const DemoCompletedPayload = z
  .object({
    /** The surface kind the spec's behaviors were exercised against. */
    surfaceKind: z.string(),
    /** How many behaviors the demo exercised (zero is recorded, not skipped). */
    behaviorCount: z.number().int(),
    /** How many behaviors PASSED their exercise. */
    passed: z.number().int(),
    /** How many behaviors FAILED their exercise. */
    failed: z.number().int(),
  })
  .strict();
