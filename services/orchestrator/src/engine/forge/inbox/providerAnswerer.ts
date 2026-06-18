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

// No bounding option remains: each provider answerer call is governed by the agent
// ActivityWatchdog (output-driven, never a wall-clock kill) the adapter constructs.
export type WrapProviderTriageAnswererOptions = Record<never, never>;

export function wrapProviderTriageAnswerer(
  adapter: AnswererAdapter<CandidateTriage>,
  _options: WrapProviderTriageAnswererOptions = {},
): TriageAnswerer {
  const jsonSchema = renderAnswererJsonSchema(CandidateTriage);
  return {
    async triage(context: TriageAnswererContext): Promise<CandidateTriage> {
      return adapter.runAnswerer({
        prompt: buildTriagePrompt(context),
        outputSchema: {
          name: SCHEMA_NAME,
          jsonSchema,
          parse: (value) => CandidateTriage.parse(value),
        },
      });
    },
  };
}
