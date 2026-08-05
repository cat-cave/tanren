// The ONE price source the cost path uses in production: OpenRouter's own live
// quote, with the LiteLLM live table behind it for direct-vendor routes.
//
// Kept in its own module (rather than inside either source) so neither live source
// imports the other, and so the composition — which is a POLICY decision about
// whose price is authoritative — is stated in exactly one readable place.
//
// WARMING, AND WHY IT DOES NOT WAIT.
// Both legs start cold and refresh in the background, so the opening calls of a
// fresh process can land before the first fetch does and record
// `price_source_unavailable`.
//
// The obvious fix — await the warm, bounded by a timeout — is FORBIDDEN here, and
// rightly so: `no-arbitrary-timeouts` (feedback_no_timeouts_progress_based) bans
// wall-clock deadlines outright, and there is no progress signal to build a
// sign-of-life primitive from for a single HTTP GET.
//
// So the warm does not wait at all. `warmCostPriceSource` merely triggers the
// refresh EARLIER than the first lookup would, and returns immediately. That is
// strictly better than a raced deadline:
//   - no wall-clock budget exists anywhere on the path;
//   - an unreachable or slow price API cannot delay, hang, or fail a run — the
//     accounting axis must never be able to hurt the delivery axis;
//   - the rows that land before the table does are not silently null. They record
//     `price_source_unavailable`, which is explicitly an INFRASTRUCTURE fault rather
//     than a fact about the model, and stays repriceable (see the run-end notional
//     reprice follow-up in docs/_design/openrouter-cost-attribution-notional.md).

import { liveModelPriceSource } from "./modelPriceSource.js";
import { openRouterPriceSource } from "./openRouterPriceSource.js";
import { CompositeModelPriceSource } from "./compositePriceSource.js";

let cached: CompositeModelPriceSource | undefined;

export function costPriceSource(): CompositeModelPriceSource {
  cached ??= new CompositeModelPriceSource(openRouterPriceSource(), liveModelPriceSource());
  return cached;
}

// Trigger both legs' background refresh without waiting for it. Safe to call more
// than once: each source is a TTL-cached singleton with a single-flight refresh, so
// a warm inside the TTL — or while a fetch is already running — is a no-op.
export function warmCostPriceSource(): void {
  costPriceSource().warm();
}
