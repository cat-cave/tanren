import { z } from "zod";

// Templating events (docs/roadmap/templating-system.md). The fragment-authoring
// lifecycle is what remains: a missing fragment spawns the per-fragment authoring
// DAG (F2), which emits these events.
//
//   • fragment.authoring.started   — an authoring run for ONE missing fragment began
//   • fragment.authoring.attempt   — one writer iteration's body + rejection + decision
//   • fragment.authoring.succeeded — the writer's body validated + persisted
//   • fragment.authoring.failed    — the writer's body did not converge (fixed point)
//
// Non-secret descriptors only (org / fragment id / attempt count / failure reason /
// bodyPreview + canonicalSignature — code is not secret, and the signature is a
// SHA-256 hash). The `bodyPreview` truncation ceiling lives at the emit site
// (`fragmentAuthoringRun.FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX`); the Zod
// schema accepts any string.

export const FragmentAuthoringStartedPayload = z
  .object({
    orgId: z.string(),
    /** The fragment id the authoring run is producing (e.g. `frontend-remix`). */
    fragmentId: z.string(),
    /** The fragment kind (one of the 9 compose phases). */
    kind: z.string(),
    /** The fragment label (the per-kind suffix that becomes `<kind>-<label>`). */
    label: z.string(),
  })
  .strict();

export const FragmentAuthoringAttemptPayload = z
  .object({
    orgId: z.string(),
    fragmentId: z.string(),
    /** 1-indexed iteration number within the writer-rework loop. */
    attempt: z.number().int().positive(),
    /** Truncated writer body (first ~500 chars) — enough for an operator to
     * identify what the writer tried without exploding the event store on a
     * long-body iteration. */
    bodyPreview: z.string(),
    /** The fixed-point key for this iteration (SHA-256 of the parsed ops when
     * parseable, else of the lexically-normalized body) — a hash, safe to log. */
    canonicalSignature: z.string(),
    /** The validator's rejection message on this attempt; empty string on the
     * successful iteration (which is followed by `fragment.authoring.succeeded`). */
    rejection: z.string(),
    /** What the loop decided after this iteration:
     *   - `continue`            — the writer made progress; another iteration runs
     *   - `converged`           — the body validated; the run terminalizes ok
     *   - `halted_fixed_point`  — identical signature + rejection ⇒ no progress; halt */
    decision: z.enum(["continue", "converged", "halted_fixed_point"]),
  })
  .strict();

export const FragmentAuthoringSucceededPayload = z
  .object({
    orgId: z.string(),
    fragmentId: z.string(),
    /** Number of writer-rework attempts before the body validated. */
    attempts: z.number().int().positive(),
  })
  .strict();

export const FragmentAuthoringFailedPayload = z
  .object({
    orgId: z.string(),
    fragmentId: z.string(),
    /** Why the run terminated (the latest rejection from the validator). */
    reason: z.string(),
    /** Number of writer-rework attempts at the fixed point. */
    attempts: z.number().int().positive(),
  })
  .strict();

/** Sub-registry spread into the main event registry. */
export const templateEventRegistry = {
  "fragment.authoring.started": FragmentAuthoringStartedPayload,
  "fragment.authoring.attempt": FragmentAuthoringAttemptPayload,
  "fragment.authoring.succeeded": FragmentAuthoringSucceededPayload,
  "fragment.authoring.failed": FragmentAuthoringFailedPayload,
} as const;
