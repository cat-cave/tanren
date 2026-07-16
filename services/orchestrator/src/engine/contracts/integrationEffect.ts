/**
 * in-2: behavior stimulus + expected external-effect contracts for an
 * IntegrationRequirementV1. Pure document types — no provisioner, no secret
 * values, no parallel proof store.
 */

import { z } from "zod";

/** Stimulus that establishes Given/When for a behavior-backed integration need. */
export const BehaviorStimulusContractV1Schema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["user_action", "http", "schedule", "event", "threshold"]),
    /** Free-text operator/Forge phrase; never a credential. */
    description: z.string().min(1).max(2000),
    given: z.string().min(1).max(2000).optional(),
    when: z.string().min(1).max(2000).optional(),
    /** Optional SP-1 behavior revision id reference (row id, not a Digest). */
    behaviorRevisionId: z.string().min(1).max(200).optional(),
    /** Optional stable behavior key before materialization. */
    behaviorKey: z.string().min(1).max(200).optional(),
  })
  .strict();

export type BehaviorStimulusContractV1 = z.infer<typeof BehaviorStimulusContractV1Schema>;

/**
 * Independent observation obligation for A3 / post-deploy proof.
 * Observation is provider-side; product-only self-report is not sufficient.
 */
export const IntegrationEffectContractV1Schema = z
  .object({
    version: z.literal(1),
    /**
     * Plane of the effect. Must match the parent requirement plane — control
     * notify effects cannot satisfy product messaging (and vice versa).
     */
    plane: z.enum(["control", "product"]),
    provider: z.string().min(1).max(64),
    /**
     * What must be observed externally (not merely an HTTP 2xx from the product).
     * Examples: message_in_channel, error_event_ingested, release_promoted.
     */
    observation: z.string().min(1).max(128),
    /** Correlation fields retained in evidence (ids/hashes only — never bodies). */
    correlationFields: z.array(z.string().min(1).max(64)).min(1).max(32),
    /** Optional sanitized template / payload digest identity (sha256:… form when set). */
    templateDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
    independent: z.literal(true),
  })
  .strict();

export type IntegrationEffectContractV1 = z.infer<typeof IntegrationEffectContractV1Schema>;
