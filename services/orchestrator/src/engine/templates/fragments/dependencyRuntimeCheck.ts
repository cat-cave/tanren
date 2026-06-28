// PRE-FLIGHT: CROSS-RUNTIME `dependsOn` CHECK (task #72).
//
// The user's standing doctrine: "no fallback paths or legacy workarounds.
// Everything in tanren should feel like the single intended way to do things."
// Silent acceptance of an incompatible (runtime, fragment) pair was the half-measure
// PR-D's matrix harness surfaced — three combos that composed without throwing but
// produced a structurally-misshaped template (node-only deps dropped because
// `processDeps` early-returns when `!vfs.has("package.json")`). This pre-flight makes
// the mismatch a deterministic, payload-bearing throw the registry routing can branch
// on, never a half-composed VFS.
//
// CONTRACT: a non-runtime fragment whose `dependsOn` lists a `kind === "runtime"`
// fragment OTHER than the active runtime is a mismatch. The walk is order-independent
// (we check the SET, not the apply order) so we don't need to call `resolveOrder`
// first. A dep id not in the library is left to `library.require` downstream — this
// pre-flight only attributes runtime mismatches, never missing deps (those belong to
// `selectFragmentConfig`'s matrix-miss routing).
//
// CALLED FROM: `composeTemplate` (compose.ts), right after the base-fragment-presence
// check + the `compose(config)` plan, BEFORE the first `applyPhase`. Throws
// deterministically so a partially-composed VFS is impossible by construction.

import { TemplateComposeError } from "./composeError.js";
import type { Fragment, FragmentLibrary } from "./types.js";

/** Walk every planned fragment + assert no cross-runtime `dependsOn` mismatch exists
 * vs. the active runtime id. Throws `TemplateComposeError("dependency_runtime_mismatch")`
 * on the FIRST offender (compose-phase order, since `plannedFragments` is supplied in
 * that order by the composer). */
export function assertDependsOnRuntimeMatchesConfig(
  plannedFragments: readonly Fragment[],
  library: FragmentLibrary,
  activeRuntimeId: string,
): void {
  for (const fragment of plannedFragments) {
    if (fragment.kind === "runtime") continue;
    for (const depId of fragment.dependsOn ?? []) {
      if (!library.has(depId)) continue;
      const dep = library.require(depId);
      if (dep.kind !== "runtime") continue;
      if (depId === activeRuntimeId) continue;
      throw new TemplateComposeError(
        "dependency_runtime_mismatch",
        `fragment "${fragment.id}" declares dependsOn ["${depId}"] but the active runtime is ` +
          `"${activeRuntimeId}" — pair "${fragment.id}" with runtime "${depId}" or pick a ` +
          `stack-compatible fragment for runtime "${activeRuntimeId}".`,
        fragment.id,
        {
          payload: {
            fragmentId: fragment.id,
            requiredRuntime: depId,
            activeRuntime: activeRuntimeId,
          },
        },
      );
    }
  }
}
