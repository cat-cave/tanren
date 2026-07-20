import { z } from "zod";

import {
  capabilityPlaneAffinity,
  INTEGRATION_CRITICALITIES,
  INTEGRATION_DIRECTIONS,
  INTEGRATION_ENVIRONMENTS,
  INTEGRATION_PLANES,
  ProviderPolicyV1Schema,
} from "../../contracts/integrationRequirement.js";
import { CapabilitySchema, ProviderKindSchema, ProviderVersionSchema } from "../fragments/model.js";

// in-8: the versioned Zod contract for `.tanren/integrations.yml` — the REPO-SOURCED
// per-project integration manifest. A project ships this file to DECLARE which
// integrations / providers it needs and, per integration, the capability, plane,
// direction, environments, required operations, required scopes, criticality, and the
// provider contract version. It is the project-authored counterpart to the
// Forge-derived `IntegrationRequirementV1` (engine/contracts/integrationRequirement.ts):
// same frozen vocabulary (planes / directions / environments / criticalities /
// provider policy from in-2, capability / provider / version shapes from the in-7
// fragment model) — never a second, invented shape.
//
// This module is the CONTRACT + shape only. Parsing YAML text into a validated
// manifest (fail-closed) and projecting it onto the in-7 derive path lives in the
// sibling `resolve.ts`, mirroring the `.tanren/ci.yml` split (ci/{schema,resolve,yaml}).

export const INTEGRATIONS_MANIFEST_API_VERSION = "tanren.dev/integrations/v1" as const;

// A manifest entry's logical name: a stable, human-authored slug used to reference
// the declared integration. Unique within the manifest (enforced below).
const IntegrationNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);

// A single declared integration. `.strict()` so an unknown / mistyped field is a
// LOUD reject (a repo-authored manifest never silently drops a misspelled key).
export const IntegrationsManifestEntryV1Schema = z
  .object({
    name: IntegrationNameSchema,
    capability: CapabilitySchema,
    provider: ProviderKindSchema,
    providerVersion: ProviderVersionSchema,
    plane: z.enum(INTEGRATION_PLANES),
    direction: z.enum(INTEGRATION_DIRECTIONS),
    environments: z.array(z.enum(INTEGRATION_ENVIRONMENTS)).min(1).max(INTEGRATION_ENVIRONMENTS.length),
    operations: z.array(z.string().min(1).max(128)).min(1).max(64),
    scopes: z.array(z.string().min(1).max(128)).min(1).max(64),
    criticality: z.enum(INTEGRATION_CRITICALITIES),
    providerPolicy: ProviderPolicyV1Schema.optional(),
  })
  .strict();
export type IntegrationsManifestEntryV1 = z.infer<typeof IntegrationsManifestEntryV1Schema>;

// The stable per-entry integration identity — the same `capability:provider@version`
// triple the in-7 fragment registry keys a provider definition by (persistedId).
// Two manifest entries that collide on this identity are ambiguous → rejected.
export function manifestEntryIdentity(entry: IntegrationsManifestEntryV1): string {
  return `${entry.capability}:${entry.provider}@${entry.providerVersion}`;
}

export const IntegrationsManifestV1Schema = z
  .object({
    apiVersion: z.literal(INTEGRATIONS_MANIFEST_API_VERSION),
    version: z.literal(1),
    integrations: z.array(IntegrationsManifestEntryV1Schema).min(1).max(64),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const namesSeen = new Set<string>();
    const identitiesSeen = new Set<string>();
    const planeByCapability = new Map<string, (typeof INTEGRATION_PLANES)[number]>();

    manifest.integrations.forEach((entry, index) => {
      // 1. Unique logical name — a duplicate name makes a downstream reference ambiguous.
      if (namesSeen.has(entry.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["integrations", index, "name"],
          message: `duplicate integration name "${entry.name}"`,
        });
      }
      namesSeen.add(entry.name);

      // 2. Unique (capability, provider, version) identity — two entries that resolve to
      //    the same provider-integration fragment are a contradiction, not a merge.
      const identity = manifestEntryIdentity(entry);
      if (identitiesSeen.has(identity)) {
        ctx.addIssue({
          code: "custom",
          path: ["integrations", index],
          message: `duplicate integration identity "${identity}"`,
        });
      }
      identitiesSeen.add(identity);

      // 3. Plane affinity — a capability with a catalogued / prefixed plane cannot be
      //    declared on the wrong plane (the in-2 rule; control creds never validate as
      //    product bindings and vice-versa).
      const affinity = capabilityPlaneAffinity(entry.capability);
      if (affinity !== "either" && affinity !== entry.plane) {
        ctx.addIssue({
          code: "custom",
          path: ["integrations", index, "plane"],
          message: `capability "${entry.capability}" requires plane "${affinity}", got "${entry.plane}"`,
        });
      }

      // 4. Single-plane capability — a capability is bound to exactly one plane across
      //    the whole manifest (matches composeIntegrationDefinitions coherence).
      const priorPlane = planeByCapability.get(entry.capability);
      if (priorPlane !== undefined && priorPlane !== entry.plane) {
        ctx.addIssue({
          code: "custom",
          path: ["integrations", index, "plane"],
          message: `capability "${entry.capability}" is declared on both "${priorPlane}" and "${entry.plane}" planes`,
        });
      }
      planeByCapability.set(entry.capability, entry.plane);

      // 5. A provider policy must never forbid the entry's own provider (self-contradiction),
      //    and preferred ⊆ allowed / preferred ∩ forbidden = ∅ (the in-2 provider-policy rule).
      const policy = entry.providerPolicy;
      if (policy !== undefined) {
        const forbidden = new Set(policy.forbidden ?? []);
        const allowed = new Set(policy.allowed ?? []);
        if (forbidden.has(entry.provider)) {
          ctx.addIssue({
            code: "custom",
            path: ["integrations", index, "providerPolicy", "forbidden"],
            message: `provider policy forbids the entry's own provider "${entry.provider}"`,
          });
        }
        for (const preferred of policy.preferred ?? []) {
          if (forbidden.has(preferred)) {
            ctx.addIssue({
              code: "custom",
              path: ["integrations", index, "providerPolicy", "preferred"],
              message: `provider "${preferred}" is both preferred and forbidden`,
            });
          }
          if (allowed.size > 0 && !allowed.has(preferred)) {
            ctx.addIssue({
              code: "custom",
              path: ["integrations", index, "providerPolicy", "preferred"],
              message: `preferred provider "${preferred}" is outside the allowed set`,
            });
          }
        }
      }
    });
  });
export type IntegrationsManifestV1 = z.infer<typeof IntegrationsManifestV1Schema>;
