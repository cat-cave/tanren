// P1c: the provider-backed discovery answerer (the real LLM seam).
//
// Adapts an `AnswererAdapter` (Claude/Codex, resolved via adapterSelector) into
// the `DiscoveryAnswerer` seam, mirroring the interview/conversation provider
// wrappers. Each `classify` is one structured provider call returning a
// `DiscoveryResult` — a real, model-derived slice of the spec DAG. Production
// wires this through the route's `answererFactory`; tests use a fake answerer so
// no test hits a provider.

import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildDiscoveryPrompt } from "./prompt.js";
import { DiscoveryResult, type DiscoveryAnswerer, type DiscoveryAnswererContext } from "./types.js";

const SCHEMA_NAME = "tanren.discovery_classification.v1";

export interface WrapProviderDiscoveryAnswererOptions {
  // Bounds each provider call. Defaults to 120s — discovery is interactive,
  // matching the conversation/interview answerer ceiling.
  timeoutMs?: number;
}

export function wrapProviderDiscoveryAnswerer(
  adapter: AnswererAdapter<DiscoveryResult>,
  options: WrapProviderDiscoveryAnswererOptions = {},
): DiscoveryAnswerer {
  const jsonSchema = renderAnswererJsonSchema(DiscoveryResult);
  return {
    async classify(context: DiscoveryAnswererContext): Promise<DiscoveryResult> {
      return adapter.runAnswerer({
        prompt: buildDiscoveryPrompt(context),
        timeoutMs: options.timeoutMs ?? 120_000,
        outputSchema: {
          name: SCHEMA_NAME,
          jsonSchema,
          parse: (value) => DiscoveryResult.parse(value),
        },
      });
    },
  };
}
