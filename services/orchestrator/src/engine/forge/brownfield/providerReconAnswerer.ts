// P1c: the provider-backed recon answerer (the real LLM seam).
//
// Adapts an `AnswererAdapter` (Claude/Codex, resolved via adapterSelector) into
// the `ReconAnswerer` seam. Each `read` is one structured provider call over the
// repo index returning a `ReconReport`. Production wires this through the route's
// `reconAnswererFactory`; tests use a fake answerer so no test hits a provider.

import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildReconPrompt } from "./prompt.js";
import { ReconReport, type ReconAnswerer, type ReconIndex } from "./types.js";

const SCHEMA_NAME = "tanren.brownfield_recon.v1";

export interface WrapProviderReconAnswererOptions {
  // Bounds each provider call. Defaults to 180s — recon reads a whole repo index
  // and produces a multi-chapter report, so it runs a touch longer than triage.
  timeoutMs?: number;
}

export function wrapProviderReconAnswerer(
  adapter: AnswererAdapter<ReconReport>,
  options: WrapProviderReconAnswererOptions = {},
): ReconAnswerer {
  const jsonSchema = renderAnswererJsonSchema(ReconReport);
  return {
    async read(index: ReconIndex): Promise<ReconReport> {
      return adapter.runAnswerer({
        prompt: buildReconPrompt(index),
        timeoutMs: options.timeoutMs ?? 180_000,
        outputSchema: {
          name: SCHEMA_NAME,
          jsonSchema,
          parse: (value) => ReconReport.parse(value),
        },
      });
    },
  };
}
