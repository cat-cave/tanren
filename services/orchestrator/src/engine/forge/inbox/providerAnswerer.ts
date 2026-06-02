// P1c: the provider-backed triage answerer (the real LLM seam).
//
// Adapts an `AnswererAdapter` (Claude/Codex, resolved via adapterSelector) into
// the `TriageAnswerer` seam. Each `triage` is one structured provider call
// returning a `CandidateTriage` — real candidate judgement against the live DAG.
// Production wires this through the route's `answererFactory`; tests use a fake
// answerer so no test hits a provider.

import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildTriagePrompt } from "./prompt.js";
import { CandidateTriage, type TriageAnswerer, type TriageAnswererContext } from "./types.js";

const SCHEMA_NAME = "tanren.candidate_triage.v1";

export interface WrapProviderTriageAnswererOptions {
  // Bounds each provider call. Defaults to 120s — triage is interactive.
  timeoutMs?: number;
}

export function wrapProviderTriageAnswerer(
  adapter: AnswererAdapter<CandidateTriage>,
  options: WrapProviderTriageAnswererOptions = {},
): TriageAnswerer {
  const jsonSchema = renderAnswererJsonSchema(CandidateTriage);
  return {
    async triage(context: TriageAnswererContext): Promise<CandidateTriage> {
      return adapter.runAnswerer({
        prompt: buildTriagePrompt(context),
        timeoutMs: options.timeoutMs ?? 120_000,
        outputSchema: {
          name: SCHEMA_NAME,
          jsonSchema,
          parse: (value) => CandidateTriage.parse(value),
        },
      });
    },
  };
}
