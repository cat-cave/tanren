// ds-3 (F2D) — the design-fragment authoring ASSEMBLY.
//
// Wires the ds-3 family binding onto the shared SP-2 authoring kernel and exposes:
//   · `buildDesignFragmentAuthoringBinding` — the per-run `AuthoringFamilyBinding`.
//   · `runDesignFragmentAuthoring`           — author a missing set through the kernel.
//   · `resolveDesignFragmentConfig`          — selector → author → HALT-LOUD, the
//     design analog of `resolveFragmentConfig` (missing + no authoring seam, or a
//     failed authoring run, throws `DesignFragmentAuthoringFailedError` — never a
//     silent skip or a fabricated fragment).

import { createAuthoringKernel } from "../../../authoring/authoringKernelRunner.js";
import type {
  AuthoringAuthorer,
  AuthoringEvents,
  AuthoringFamilyBinding,
  AuthoringKernel,
  AuthoringKernelResult,
  AuthoringPersistence,
} from "../../../contracts/authoringKernel.js";
import type { DesignArtifactFileV1, DesignFragmentSpecV1 } from "../designArtifactSchemas.js";
import type { DesignTargetAdapter } from "../designTargetAdapter.js";
import { parseDesignFragmentAuthoringContext, type DesignFragmentAuthoringContext } from "./designFragmentContext.js";
import type { DesignFragmentAuthoringEvent } from "./designFragmentEvents.js";
import { designFragmentSignatures } from "./designFragmentAuthorer.js";
import { buildDesignFragmentBatchCompose } from "./designFragmentBatchCompose.js";
import { buildDesignFragmentValidator } from "./designFragmentValidator.js";
import type { DesignFragmentDraftV1, ValidatedDesignFragment } from "./designFragmentDraft.js";
import {
  designFragmentKey,
  selectMissingDesignFragments,
  type PresentDesignFragmentKey,
} from "./designFragmentSelector.js";
import type { DesignFragmentPersistenceStore } from "./designFragmentStore.js";

type Binding = AuthoringFamilyBinding<
  DesignFragmentSpecV1,
  DesignFragmentDraftV1,
  ValidatedDesignFragment,
  DesignFragmentAuthoringEvent
>;

/** The per-unit authoring unit id — kind@label (org-independent; the persisted
 * release id carries the org). Also the `fragmentAuthoringRunId` on every event. */
export function designFragmentUnitId(spec: DesignFragmentSpecV1): string {
  return designFragmentKey(spec);
}

/** Loud halt when the F2D loop cannot produce a valid fragment for every missing
 * slot — the design analog of `FragmentAuthoringFailedError`. NEVER a silent skip. */
export class DesignFragmentAuthoringFailedError extends Error {
  constructor(
    readonly failedIds: readonly string[],
    readonly failureReasons: Readonly<Record<string, string>> = {},
  ) {
    super(`design fragment authoring failed for: ${failedIds.join(", ") || "<none>"}`);
    this.name = "DesignFragmentAuthoringFailedError";
  }
}

/** The dependencies a live F2D run is built with. */
export interface DesignFragmentAuthoringDeps {
  /** The writer seam — production wires `wrapProviderDesignFragmentAuthorer` (real
   * LLM); tests inject a deterministic fixture through the SAME seam. */
  readonly authorer: AuthoringAuthorer<DesignFragmentSpecV1, DesignFragmentDraftV1>;
  /** The ds-2 target adapter capabilities are checked/composed against. */
  readonly adapter: DesignTargetAdapter;
  /** The org-scoped registry store (atomic persist + retract). */
  readonly store: DesignFragmentPersistenceStore;
  /** The frozen `designFragment.authoring.*` event factory + EventStore sink. */
  readonly events: AuthoringEvents<
    DesignFragmentSpecV1,
    DesignFragmentDraftV1,
    ValidatedDesignFragment,
    DesignFragmentAuthoringEvent
  >;
  /** Cross-run collision defense: the org's present fragment files for the batch gate. */
  readonly loadPresentFiles?: (orgId: string) => Promise<readonly DesignArtifactFileV1[]>;
  /** The shared kernel (default: a fresh `createAuthoringKernel`). */
  readonly kernel?: AuthoringKernel<
    DesignFragmentSpecV1,
    DesignFragmentDraftV1,
    ValidatedDesignFragment,
    DesignFragmentAuthoringEvent
  >;
}

/** Build the per-run family binding (closes over the resolved org scope so the
 * persistence retract — which the kernel calls with only a persistedId — can bind
 * the org for its RLS-scoped DELETE). */
export function buildDesignFragmentAuthoringBinding(
  deps: DesignFragmentAuthoringDeps,
  context: DesignFragmentAuthoringContext,
): Binding {
  const persistence: AuthoringPersistence<DesignFragmentSpecV1, DesignFragmentDraftV1, ValidatedDesignFragment> = {
    async createValidated(input): Promise<{ persistedId: string }> {
      return deps.store.createValidated({
        orgId: context.orgId,
        createdBy: context.createdBy,
        fragment: input.validated,
      });
    },
    async deleteById(persistedId): Promise<void> {
      await deps.store.deleteById(context.orgId, persistedId);
    },
  };

  return {
    familyId: "ds-3",
    unitId: designFragmentUnitId,
    authorer: deps.authorer,
    validator: buildDesignFragmentValidator(() => deps.adapter),
    persistence,
    batchCompose: buildDesignFragmentBatchCompose({
      adapter: deps.adapter,
      ...(deps.loadPresentFiles === undefined ? {} : { loadPresentFiles: deps.loadPresentFiles }),
    }),
    signatures: designFragmentSignatures,
    events: deps.events,
  };
}

/** Author every missing design fragment through the shared kernel. Returns the
 * committed validated set (retracted units are absent) + the failed set. */
export async function runDesignFragmentAuthoring(input: {
  readonly missing: readonly DesignFragmentSpecV1[];
  readonly context: unknown;
  readonly deps: DesignFragmentAuthoringDeps;
}): Promise<AuthoringKernelResult<ValidatedDesignFragment>> {
  const context = parseDesignFragmentAuthoringContext(input.context);
  const binding = buildDesignFragmentAuthoringBinding(input.deps, context);
  const kernel =
    input.deps.kernel ??
    createAuthoringKernel<
      DesignFragmentSpecV1,
      DesignFragmentDraftV1,
      ValidatedDesignFragment,
      DesignFragmentAuthoringEvent
    >();
  return kernel.run({ missing: input.missing, context }, binding);
}

/** Selector → author → HALT-LOUD. Selects the missing fragments; if none, resolves
 * immediately. Otherwise authors them (when a `runAuthoring` seam is supplied) and
 * throws `DesignFragmentAuthoringFailedError` if any slot could not be produced — or
 * if no authoring seam exists at all. Mirrors `resolveFragmentConfig`. */
export async function resolveDesignFragmentConfig(input: {
  readonly required: readonly DesignFragmentSpecV1[];
  readonly present: readonly PresentDesignFragmentKey[];
  readonly runAuthoring?: (
    missing: readonly DesignFragmentSpecV1[],
  ) => Promise<AuthoringKernelResult<ValidatedDesignFragment>>;
}): Promise<{ readonly authored: readonly ValidatedDesignFragment[] }> {
  const missing = selectMissingDesignFragments(input.required, input.present);
  if (missing.length === 0) return { authored: [] };

  if (input.runAuthoring === undefined) {
    throw new DesignFragmentAuthoringFailedError(missing.map((spec) => designFragmentUnitId(spec)));
  }

  const result = await input.runAuthoring(missing);
  if (result.failedIds.length > 0) {
    throw new DesignFragmentAuthoringFailedError(result.failedIds, result.failureReasons);
  }
  return { authored: result.validated };
}
