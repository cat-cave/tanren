// ds-7 — F2D authoring helper extracted from the multi-target composer to keep
// that file under the import-dependency cap. TARGET-AGNOSTIC: authors the
// missing design fragments through the shared ds-3 kernel.

import { randomUUID } from "node:crypto";
import type { DesignContractV2 } from "./designContractV2.js";
import { resolveDtcgTokens } from "./dtcgResolver.js";
import { buildWebAdapterForF2d, digestOf } from "./composeProjectTargetDesignSystemsHelpers.js";
import {
  createDesignFragmentAuthoringEvents,
  DesignFragmentAuthoringFailedError,
  DesignFragmentStore,
  requiredDesignFragmentsFromSurfaces,
  runDesignFragmentAuthoring,
  selectMissingDesignFragments,
  wrapProviderDesignFragmentAuthorer,
} from "./authoring/index.js";
import type { ComposeProjectTargetDesignSystemsDeps } from "./composeProjectTargetDesignSystems.js";

/** The plain base token set the composer bootstraps every adapter from. */
export const PLAIN_BASE_TOKENS = {
  color: {
    background: { $type: "color", $value: "#ffffff" },
    foreground: { $type: "color", $value: "#101828" },
    border: { $type: "color", $value: "#d0d5dd" },
    primary: { $type: "color", $value: "#155eef" },
  },
  radius: { md: { $type: "dimension", $value: "0.375rem" } },
  space: { md: { $type: "dimension", $value: "0.5rem" } },
} as const;

/** Author the missing design fragments via F2D (target-agnostic). */
export async function authorMissingFragments(
  deps: ComposeProjectTargetDesignSystemsDeps,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly contractV2: DesignContractV2;
  },
): Promise<{ readonly authoredIds: string[]; readonly authoredFragmentDigests: string[] }> {
  const requiredFragments = requiredDesignFragmentsFromSurfaces(input.contractV2);
  const fragmentStore = new DesignFragmentStore(deps.pool);
  const present = await fragmentStore.listPresentByOrg(input.orgId);
  const presentFiles = await fragmentStore.listPresentFilesByOrg(input.orgId);
  const missing = selectMissingDesignFragments(requiredFragments, present);
  const authoredIds: string[] = [];
  const authoredFragmentDigests: string[] = [];
  if (missing.length === 0) return { authoredIds, authoredFragmentDigests };
  const authorer = wrapProviderDesignFragmentAuthorer(deps.fragmentAnswerer, { contract: input.contractV2 });
  // The F2D validation adapter is the web adapter — the kernel validates
  // authored fragments against the same plain base every target shares. This
  // is NOT a web fallback: F2D authoring is target-agnostic by design.
  const f2dValidationAdapter = buildWebAdapterForF2d(randomUUID(), randomUUID(), resolveDtcgTokens(PLAIN_BASE_TOKENS));
  const result = await runDesignFragmentAuthoring({
    missing,
    context: { orgId: input.orgId, projectId: input.projectId, createdBy: deps.createdBy },
    deps: {
      authorer,
      adapter: f2dValidationAdapter,
      store: fragmentStore,
      events: createDesignFragmentAuthoringEvents(deps.eventStore),
      loadPresentFiles: async () => presentFiles,
    },
  });
  if (result.failedIds.length > 0) {
    throw new DesignFragmentAuthoringFailedError([...result.failedIds], result.failureReasons);
  }
  for (const validated of result.validated) {
    authoredIds.push(validated.fragmentReleaseId);
    authoredFragmentDigests.push(validated.fragmentDigest);
  }
  return { authoredIds, authoredFragmentDigests };
}

/** The plain-release digest anchor over the shared plain base. */
export function plainReleaseDigest(): string {
  return digestOf(["tanren.ds-composer.plain.v1", PLAIN_BASE_TOKENS]);
}

/** The polished-release digest anchor over a contract + authored fragment set. */
export function polishedReleaseDigest(contractDigest: string, authoredFragmentDigests: readonly string[]): string {
  return digestOf(["tanren.ds-composer.polished.v1", contractDigest, [...authoredFragmentDigests].sort()]);
}
