import { z } from "zod";

// in-17 durable post-merge delivery DAG — the release-activation surface (integrations.md
// §F "turn landing into release activation"). MergeAuthority stays the sole land decision;
// these events NARRATE the delivery DAG that runs strictly AFTER the authorized-land
// transaction commits and NEVER land code. Both carry references + digests only — never a
// token, a secret value, or a provider response body.
//
//   - delivery.completed → the delivery DAG confirmed EVERY applicable stage and recorded
//                          the SIGNED evidence of the independently-observed effect (the A3
//                          Then). This is the fail-closed completion attestation: it is
//                          appended ONLY when the observed effect is confirmed, so its mere
//                          presence proves the delivery genuinely activated the release.
//   - delivery.degraded  → a stage could not confirm its external effect; the delivery is
//                          in an explicit durable DEGRADED state (resumable next wake), NOT
//                          silently reported complete.
//   - delivery.demo_stimulus_started → the durable INTENT MARKER recorded (under the
//                          cross-process advisory lock) before the demo behavior effect is
//                          dispatched. A LIVE intent = more `started` than `aborted`.
//   - delivery.demo_stimulus_aborted → clears a `started` intent when the drive PROVED the
//                          external effect never dispatched (the runner returned/threw leaving
//                          NO terminal demo event, so the only pre-terminal awaitable — a pure
//                          read — failed). This makes a never-fired demo able to re-fire instead of
//                          stranding it degraded. On resume: a LIVE intent (started>aborted)
//                          without a terminal ⇒ a genuine crash mid-dispatch ⇒ degrade (never
//                          re-fire); otherwise the demo FIRES.

const Sha256Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

/** What was INDEPENDENTLY observed as the delivery's external effect. */
const ObservedEffect = z.enum([
  // No external surface to observe (no deploy configured) — a legitimate no-op delivery.
  "none",
  // The merged SHA deployed + verified live, but the product declares no observable behavior.
  "deploy_verified",
  // The deployed behavior was independently exercised against the live surface (demo A3 Then).
  "demo_observed",
]);

export const DeliveryCompletedPayload = z
  .object({
    /** The durable `delivery_runs` row this delivery completed. */
    deliveryRunId: z.string(),
    /** The merged commit SHA this delivery activated. */
    mergeSha: z.string(),
    /** The verified deployment's provider handle, when a deploy was part of the delivery. */
    deploymentId: z.string().optional(),
    /** The delivery stages confirmed (in order) — the causal chain merge → observed effect. */
    stagesConfirmed: z.array(z.string()),
    /** What was independently observed as the release's external effect. */
    observedEffect: ObservedEffect,
    /** sha256 over the canonical confirmed-observation evidence (tamper-evident content id). */
    evidenceDigest: Sha256Digest,
    /** The signed attestation over the evidence (HMAC when a signing key is configured, else the content-bound digest). */
    signature: z.string(),
  })
  .strict();

export const DeliveryDegradedPayload = z
  .object({
    /** The durable `delivery_runs` row that degraded. */
    deliveryRunId: z.string(),
    /** The stage that could not confirm its external effect. */
    stage: z.string(),
    /** The machine-parseable degrade classification. */
    classification: z.string(),
    /** A fixed, non-secret operator-facing detail. */
    detail: z.string(),
  })
  .strict();

export const DeliveryDemoStimulusStartedPayload = z
  .object({
    /** The durable `delivery_runs` row whose demo effect is about to fire. */
    deliveryRunId: z.string(),
    /** The merged commit SHA the delivery activates. */
    mergeSha: z.string(),
  })
  .strict();

export const DeliveryDemoStimulusAbortedPayload = z
  .object({
    /** The durable `delivery_runs` row whose fire-intent is cleared (effect never dispatched). */
    deliveryRunId: z.string(),
    /** The machine-parseable reason the effect proved not-dispatched (e.g. `no_terminal_after_run`). */
    reason: z.string(),
  })
  .strict();
