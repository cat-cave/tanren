// ds-3 (F2D) — the SELECTOR: which design fragment(s) are MISSING.
//
// The design analog of `selectFragmentConfig.ts`. The composition need (the
// fragment specs a DesignContractV2 requires of its target) is filtered against the
// org's PRESENT design-fragment registry; every required spec whose (kind, label)
// is not already registered is a MISSING fragment the F2D loop must author. An
// unknown-but-valid capability is a GAP, never a silent "closest available"
// substitution (the ds-0 open-world doctrine).

import type { DesignContractV2 } from "../designContractV2.js";
import { parseDesignFragmentSpec, type DesignFragmentSpecV1 } from "../designArtifactSchemas.js";

/** A registered fragment's identity in the org's design-fragment registry. */
export interface PresentDesignFragmentKey {
  readonly kind: string;
  readonly label: string;
}

/** The stable dedupe key for a fragment: its open-world capability kind + label. */
export function designFragmentKey(fragment: { kind: string; label: string }): string {
  return `${fragment.kind}@${fragment.label}`;
}

/** Filter the REQUIRED specs against the PRESENT registry — the missing set. A
 * required spec already present (by kind+label) is satisfied and dropped. Duplicate
 * required specs collapse to one so the authoring loop authors each unit once. */
export function selectMissingDesignFragments(
  required: readonly DesignFragmentSpecV1[],
  present: readonly PresentDesignFragmentKey[],
): DesignFragmentSpecV1[] {
  const presentKeys = new Set(present.map((key) => designFragmentKey(key)));
  const missing: DesignFragmentSpecV1[] = [];
  const seen = new Set<string>();
  for (const spec of required) {
    const key = designFragmentKey(spec);
    if (presentKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    missing.push(spec);
  }
  return missing;
}

/** Derive the composition-need fragment specs a contract's DESIRED SURFACES imply.
 *
 * Each `desiredSurface` a contract declares is a `patterns-and-templates` fragment
 * the design system must carry (the surface's persona/behavior refs flow through so
 * the ds-4 oracle can judge per-persona). This is a modest, defensible mapping — the
 * full contract→fragment-graph compiler is ds-5; ds-3 needs a real, contract-driven
 * source of REQUIRED specs to select against, and surfaces are the stable one. */
export function requiredDesignFragmentsFromSurfaces(contract: DesignContractV2): DesignFragmentSpecV1[] {
  return contract.desiredSurfaces.map((surface) =>
    parseDesignFragmentSpec({
      kind: `surface/${surface.key}`,
      label: surface.label,
      phase: "patterns-and-templates",
      version: "1.0.0",
      targetCapabilities: [],
      requires: [],
      provides: [`surface:${surface.key}`],
      dependsOn: [],
      conflicts: [],
      replaces: [],
      personaRefs: [...surface.personaRefs],
      behaviorRefs: [...surface.behaviorRefs],
      conformanceSuiteId: `surface.${surface.key}.conformance.v1`,
    }),
  );
}
