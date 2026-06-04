// CI-intelligence PR3 — the CI-insights source connector.
//
// Unlike the issue/error connectors (which PULL items from an external tracker),
// the CI-insights source has no external feed to poll: its candidates are EMITTED
// by the worker's `CiInsightsLoop` (it reduces the project's CI history into
// genuine recurring problems and upserts one candidate per problem, exactly as the
// scheduled-audit scheduler emits its findings). So this connector pulls NOTHING —
// `fetch` returns `[]`. It is registered only so the source kind is a recognized,
// non-pollable member of the connector map (a stray `ingestSource` over it is a
// safe no-op); the loop is the sole producer of CI-insight candidates.

import type { IngestedItem, InboxSource, SourceConnector } from "./types.js";

/**
 * Build the CI-insights connector. It is keyed on the `system` source kind (the
 * CI-insights source is a `system` source — no `inbox_sources` kind migration) and
 * yields no items: the worker loop emits CI-insight candidates directly, so there
 * is nothing for a pull connector to fetch.
 */
export function createCiInsightsConnector(): SourceConnector {
  return {
    kind: "system",
    async fetch(_source: InboxSource): Promise<IngestedItem[]> {
      return [];
    },
  };
}
