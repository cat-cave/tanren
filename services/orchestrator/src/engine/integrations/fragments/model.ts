// in-7 — the INTEGRATION-FRAGMENT domain model: a provider-specific integration
// DEFINITION (capability + provider + plane + binding-output kinds + validation
// plan) that the integration derivation/lifecycle phase needs to reconcile a
// project's requirement. This is the declarative F2 output — deliberately NO
// source code, expression, command, or credential field.
//
// It is grounded in the merged in-2 contracts (integrationBindingOutput +
// integrationRequirement): binding-output kinds, the validation plan, planes /
// directions / criticalities, and the provider policy are the same frozen
// vocabularies the requirement compiler and reconcile saga consume — never a
// second, invented shape.

import { createHash } from "node:crypto";
import { z } from "zod";
import { ALL_BINDING_OUTPUT_KINDS, planeOfBindingKind } from "../../contracts/integrationBindingOutput.js";
import {
  INTEGRATION_CRITICALITIES,
  INTEGRATION_DIRECTIONS,
  INTEGRATION_PLANES,
  IntegrationValidationPlanV1Schema,
  ProviderPolicyV1Schema,
} from "../../contracts/integrationRequirement.js";

const Capability = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/u);
const ProviderKind = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/u);
const Version = z.string().regex(/^\d+\.\d+\.\d+$/u);
const Operation = z.string().min(1).max(128);

export const IntegrationFragmentSpecSchema = z
  .object({
    capability: Capability,
    providerKind: ProviderKind,
    plane: z.enum(INTEGRATION_PLANES),
    version: Version,
  })
  .strict();
export type IntegrationFragmentSpec = z.infer<typeof IntegrationFragmentSpecSchema>;

/** One binding-output the provider integration produces (in-2 vocabulary). */
const BindingOutputSchema = z
  .object({
    kind: z.enum(ALL_BINDING_OUTPUT_KINDS),
    logicalKey: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Z][A-Z0-9_]*$/u),
    classification: z.enum(["secret_ref", "plain", "handle"]),
    required: z.boolean(),
  })
  .strict();

/** The authored declarative provider integration definition. No secrets, no code. */
export const IntegrationFragmentDefinitionSchema = z
  .object({
    direction: z.enum(INTEGRATION_DIRECTIONS),
    criticality: z.enum(INTEGRATION_CRITICALITIES),
    bindingOutputs: z.array(BindingOutputSchema).min(1).max(64),
    operations: z.array(Operation).min(1).max(64),
    validationPlan: IntegrationValidationPlanV1Schema,
    providerPolicy: ProviderPolicyV1Schema.optional(),
  })
  .strict();

/** Declarative F2 output for one provider integration definition. */
export const IntegrationFragmentDraftSchema = z
  .object({
    spec: IntegrationFragmentSpecSchema,
    definition: IntegrationFragmentDefinitionSchema,
  })
  .strict();
export type IntegrationFragmentDraft = z.infer<typeof IntegrationFragmentDraftSchema>;

export const IntegrationFragmentConfigSchema = z
  .object({
    apiVersion: z.literal("tanren.dev/integration-fragments/v1"),
    schemaVersion: z.literal(1),
    fragments: z.array(IntegrationFragmentSpecSchema).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.fragments.map((spec) => persistedId(spec));
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "integration fragment ids must be unique" });
    }
  });
export type IntegrationFragmentConfig = z.infer<typeof IntegrationFragmentConfigSchema>;

export interface ValidatedIntegrationFragment {
  readonly draft: IntegrationFragmentDraft;
  readonly fragmentDigest: string;
}

export const IntegrationFragmentSnapshotEntrySchema = z
  .object({
    capability: Capability,
    providerKind: ProviderKind,
    version: Version,
    fragmentDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict();
export type IntegrationFragmentSnapshotEntry = z.infer<typeof IntegrationFragmentSnapshotEntrySchema>;

export class IntegrationFragmentValidationError extends Error {
  constructor(readonly reason: string) {
    super(`integration fragment validation failed: ${reason}`);
    this.name = "IntegrationFragmentValidationError";
  }
}

export class IntegrationFragmentCompositionError extends Error {
  constructor(readonly reason: string) {
    super(`integration fragment composition failed: ${reason}`);
    this.name = "IntegrationFragmentCompositionError";
  }
}

/**
 * Validate one authored provider integration definition: strict shape + the in-2
 * semantic invariants (plane affinity of every binding-output, and a provider
 * policy that never forbids its own provider). Throws a typed error on any breach.
 */
export function validateIntegrationFragment(input: unknown): ValidatedIntegrationFragment {
  let draft: IntegrationFragmentDraft;
  try {
    draft = IntegrationFragmentDraftSchema.parse(input);
  } catch (error) {
    throw new IntegrationFragmentValidationError(error instanceof Error ? error.message : String(error));
  }

  for (const output of draft.definition.bindingOutputs) {
    const kindPlane = planeOfBindingKind(output.kind);
    if (kindPlane !== draft.spec.plane) {
      throw new IntegrationFragmentValidationError(
        `binding output ${output.kind} is a ${kindPlane}-plane kind but the definition declares plane ${draft.spec.plane}`,
      );
    }
  }

  const forbidden = draft.definition.providerPolicy?.forbidden ?? [];
  if (forbidden.includes(draft.spec.providerKind)) {
    throw new IntegrationFragmentValidationError(
      `provider policy forbids the definition's own provider ${draft.spec.providerKind}`,
    );
  }

  return { draft, fragmentDigest: digest(draft) };
}

/**
 * Compose the augmented set of provider integration definitions. Coherence: each
 * (capability, provider, version) identity is unique, and every definition for a
 * given capability agrees on the capability's plane (a capability is single-plane).
 * A failed compose is the kernel's retract-before-`failed` signal.
 */
export function composeIntegrationDefinitions(fragments: readonly ValidatedIntegrationFragment[]): {
  readonly definitions: readonly ValidatedIntegrationFragment[];
  readonly snapshot: readonly IntegrationFragmentSnapshotEntry[];
} {
  const seen = new Set<string>();
  const planeByCapability = new Map<string, "control" | "product">();
  for (const fragment of fragments) {
    const id = persistedId(fragment.draft.spec);
    if (seen.has(id)) throw new IntegrationFragmentCompositionError(`duplicate integration fragment id: ${id}`);
    seen.add(id);
    const capability = fragment.draft.spec.capability;
    const priorPlane = planeByCapability.get(capability);
    if (priorPlane !== undefined && priorPlane !== fragment.draft.spec.plane) {
      throw new IntegrationFragmentCompositionError(
        `capability ${capability} is bound to both ${priorPlane} and ${fragment.draft.spec.plane} planes`,
      );
    }
    planeByCapability.set(capability, fragment.draft.spec.plane);
  }

  const ordered = [...fragments].sort((left, right) =>
    persistedId(left.draft.spec) < persistedId(right.draft.spec) ? -1 : 1,
  );
  return {
    definitions: ordered,
    snapshot: ordered.map((fragment) => ({
      capability: fragment.draft.spec.capability,
      providerKind: fragment.draft.spec.providerKind,
      version: fragment.draft.spec.version,
      fragmentDigest: fragment.fragmentDigest,
    })),
  };
}

/** The stable per-unit identity: `capability:provider@version`. */
export function persistedId(spec: IntegrationFragmentSpec): string {
  return `${spec.capability}:${spec.providerKind}@${spec.version}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
