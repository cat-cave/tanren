// observability: timing decorator for the Writer provider boundary.
// Implements WriterAdapter and delegates to a real adapter, emitting one
// structured timing record per runWriter call. The provider's core logic is
// NOT rewritten — this only measures latency at the call boundary.
//
// Kept in its own file (separate from the Answerer wrapper) so neither file
// mixes the writer and answerer execution paths, honoring the
// writer-answerer-separation architecture rule.
import type { WriterAdapter, WriterResult } from "../providers/types.js";
import { consoleTimingSink, timed, type TimingSink } from "./timing.js";

export function timedWriterAdapter(inner: WriterAdapter, sink: TimingSink = consoleTimingSink): WriterAdapter {
  return {
    kind: inner.kind,
    cli: inner.cli,
    authRef: inner.authRef,
    // Forward the wrapped adapter's DECLARED model id. This decorator is the
    // instance `adapterSelector` returns and the workflow holds, so a field it
    // does not copy does not exist as far as production is concerned. Omitting
    // `model` here made every cost row record `model: ""` (the cost sites read
    // `adapter.model ?? ""`), which in turn made `notional_cost_usd` NULL on 100%
    // of rows — see docs/_design/openrouter-cost-attribution.md §11.
    // Spread-conditional (not `model: inner.model`) so an adapter that genuinely
    // declares NO model keeps the property ABSENT rather than gaining an explicit
    // `undefined`, preserving the "no model id → notional NULL, stay quiet" path
    // for fake fixtures.
    ...(inner.model !== undefined && { model: inner.model }),
    runWriter: (opts) =>
      timed<WriterResult>(
        {
          boundary: "provider",
          operation: "provider.write",
          sink,
          attributes: { cli: inner.cli, role: "writer" },
        },
        () => inner.runWriter(opts),
      ),
  };
}
