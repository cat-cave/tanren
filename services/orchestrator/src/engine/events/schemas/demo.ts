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

// demo.failed ("the demo could NOT record its evidence"): a run with a VERIFIED deploy
// reached the demo watcher but the demo could not complete — a resolve-surface failure
// (grant disappeared mid-flight / the DeployAdapter's `demoSurface` provider read threw),
// an unsupported surface kind (`package` / `app_channel` / `download` — resolved by their
// adapters but not yet exercisable), a spec-behavior load failure, or an unclassified
// exercise throw. Recorded DURABLY (mirrors `deploy.failed`) so the operator SEES the
// demo failure on the run timeline + is notified (→ `warn`), instead of a `log.error`
// swallowed by the post-merge subscriber. SECURITY: non-secret — a fixed reason code + a
// bounded non-secret detail string; never a token, credential ref, or response body.
export const DemoFailedPayload = z
  .object({
    /**
     * Why the demo could not complete (fixed reason code, drives operator triage).
     *   • `resolve_surface_failed`    — resolveSurface() threw (grant disappeared, the
     *     DeployAdapter's `demoSurface` read failed, or the surface URL is empty).
     *   • `load_behaviors_failed`     — the spec-behaviors read threw before any exercise.
     *   • `unsupported_surface_kind`  — the deployed surface kind has no per-behavior
     *     exercise arm yet (`package` / `app_channel` / `download`).
     *   • `exercise_failed`           — an unclassified throw during behavior exercise
     *     (probe / event append). The full error is preserved via the re-throw.
     */
    reason: z.enum(["resolve_surface_failed", "load_behaviors_failed", "unsupported_surface_kind", "exercise_failed"]),
    /**
     * A bounded, NON-SECRET detail string — the failure summary the operator sees. Never
     * the raw error (which can embed provider-supplied HTTP response text); the full error
     * is preserved via the subscriber's `log.error` re-throw.
     */
    detail: z.string(),
    /** The deploy provider kind the demo was resolving against (`deploy.vercel` | `deploy.flyio`). */
    provider: z.string().optional(),
    /**
     * The surface kind the demo would have exercised (`web_url` / `package` / ...). Present
     * on `unsupported_surface_kind` (the surface DID resolve — it is just not exercisable);
     * absent on a `resolve_surface_failed` that never got a kind — an honest absence.
     */
    surfaceKind: z.string().optional(),
  })
  .strict();
export type DemoFailedPayload = z.infer<typeof DemoFailedPayload>;
