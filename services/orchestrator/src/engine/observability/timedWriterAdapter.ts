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
