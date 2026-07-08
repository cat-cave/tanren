// POST-AUTHORING BATCH COMPOSE — the final F2 validate step (docs/roadmap/templating-system.md).
//
// THE BUG THIS FIX CLOSES. The per-fragment authoring loop validates each
// missing fragment INDIVIDUALLY: the isolated smoke composes just that
// fragment against a synthetic `node-pnpm` runtime, and the full-library
// smoke fills every bundled slot alongside it. NEITHER SMOKE composes the
// FRESHLY-AUTHORED FRAGMENTS TOGETHER against the CAPTURED RUNTIME. A run
// missing `runtime-python-poetry` AND `frontend-nextjs` validates each on its
// own — both pass — but derive's real compose then throws
// `dependency_runtime_mismatch` because `frontend-nextjs` declares
// `dependsOn: ["runtime-node-pnpm"]` while the active runtime is
// `runtime-python-poetry`. The per-fragment smokes had no way to see this
// class of failure because they only ever composed one authored fragment at
// a time.
//
// THE FIX. After the sequential per-fragment loop finishes, if ANY fragment
// authored, run ONE final full-compose against the CAPTURED runtime + every
// freshly-authored fragment, using the augmented library. A
// `TemplateComposeError` (any phase — dependency_runtime_mismatch is the
// classic case, but a post-process dep collision or a justfile hook clash
// against the specific captured stack is caught here too) attributes the
// failure to ALL freshly-authored fragments (the specific attribution is
// intractable — the compose combines them non-linearly), moving them to
// `failedIds` so the derive halts loud with the batch-compose reason.
//
// ATTRIBUTION LOGIC. When the batch compose fails, we do NOT know which
// authored fragment is at fault — the failure emerges from their COMBINATION
// with the captured runtime + the bundled slots the derive would fill. The
// conservative call is to attribute to EVERY authored fragment: move all to
// failedIds so the derive halts, and the operator can re-run authoring (or
// hand-edit the fragments in the org's `fragments` table). A finer-grained
// bisection would require re-running per-subset composes (2^N cost) — not
// worth it: the F2 authoring loop's next iteration will re-generate against
// the sharper rejection, and the batch smoke will re-run.

import { composeTemplate } from "./compose.js";
import { deriveTemplateConfigFromLifecycle, UnresolvableLifecycleError } from "./selectFragmentConfig.js";
import type { FragmentLibrary } from "./types.js";
import type { CaptureLifecycle } from "../../forge/interview/types.js";

/** Result of the post-authoring batch compose. */
export type BatchComposeResult =
  | { kind: "ok" }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string; involvedIds: readonly string[] };

/** Run the final full-compose against the augmented library + the CAPTURED
 * lifecycle. Called by `buildFragmentAuthoring` after the sequential loop,
 * whenever `authored.length > 0`. Non-throwing — every failure surfaces as a
 * `failed` result so the caller can move the involved specs to failedIds. */
export async function runPostAuthoringBatchCompose(args: {
  lifecycle: CaptureLifecycle;
  library: FragmentLibrary;
  /** The freshly-authored spec ids (used to attribute a batch failure back to
   * authoring — see the module-header ATTRIBUTION LOGIC section). */
  authoredSpecIds: readonly string[];
}): Promise<BatchComposeResult> {
  // Derive the config from the captured lifecycle. If the lifecycle cannot be
  // resolved (an empty stack / deploy — a wiring bug), we surface as `skipped`
  // — the batch compose is a post-authoring safety net, not the primary
  // resolver of lifecycle wiring bugs (that's `deriveTemplateConfigFromLifecycle`
  // at the derive's kick-off). The derive path already threw before we got
  // here on this shape; a batch-compose skip here just avoids masking the
  // real cause.
  let configResult;
  try {
    configResult = deriveTemplateConfigFromLifecycle(args.lifecycle);
  } catch (err) {
    if (err instanceof UnresolvableLifecycleError) {
      return { kind: "skipped", reason: `unresolvable_lifecycle: ${err.message}` };
    }
    throw err;
  }

  try {
    await composeTemplate(configResult.config, args.library);
    return { kind: "ok" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: "failed",
      reason: `batch_compose_failed: ${message}`,
      involvedIds: args.authoredSpecIds,
    };
  }
}
