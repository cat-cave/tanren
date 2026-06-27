import { z } from "zod";

// Templating events (docs/roadmap/templating-system.md). The wave-1 template
// REGISTRY lifecycle + the wave-4 just-in-time creation + the wave-5 maintenance
// vocabularies are GONE with the doctrine collapse — there is no template
// registry, no agent template-build DAG, no template-maintenance scheduler. What
// remains here is the per-fragment authoring run (F2) lifecycle:
//
//   • fragment.authoring.started   — an authoring run for ONE missing fragment began
//   • fragment.authoring.succeeded — the writer's body validated + persisted
//   • fragment.authoring.failed    — the writer's body did not converge (fixed point)
//
// Non-secret descriptors only (org / fragment id / attempt count / failure reason).

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
  "fragment.authoring.succeeded": FragmentAuthoringSucceededPayload,
  "fragment.authoring.failed": FragmentAuthoringFailedPayload,
} as const;
