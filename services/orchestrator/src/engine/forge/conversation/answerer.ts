// the conversation answerer implementations.
//
//   - `ForgeAnswererStepSchema`   — the strict JSON contract the provider
//     returns each step (request read tools OR finalize a ForgeAnswer).
//   - `wrapProviderAnswerer`      — adapts a AnswererAdapter (Claude /
//     Codex, resolved via adapterSelector) into a ForgeConversationAnswerer.
//
// The scripted fake answerer lives under tests/fixtures (P1c §8a) — it is a
// test stand-in and must never be constructed by a production path.

import { z } from "zod";
import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import { ForgeAnswer, ForgeToolCall } from "../../answerers/schemas/forge.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildForgePrompt } from "./prompt.js";
import { isReadToolName } from "./types.js";
import type {
  ForgeAnswererStep,
  ForgeConversationAnswerer,
  ForgeConversationContext,
  ForgeReadToolCall,
} from "./types.js";

// The provider returns this discriminated union each step. We re-use the
// existing ForgeToolCall union for the tool variant but reject non-read tools
// at the engine boundary (defence in depth; the prompt also forbids them).
export const ForgeAnswererStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tools"), toolCalls: z.array(ForgeToolCall).min(1) }).strict(),
  z.object({ kind: z.literal("final"), answer: ForgeAnswer }).strict(),
]);

export type ForgeAnswererStepOutput = z.infer<typeof ForgeAnswererStepSchema>;

const STEP_SCHEMA_NAME = "tanren.forge_conversation_step.v1";

// No bounding option remains: each provider answerer call is governed by the agent
// ActivityWatchdog (output-driven, never a wall-clock kill) the adapter constructs.
export type WrapProviderAnswererOptions = Record<never, never>;

// Adapts a provider AnswererAdapter into the conversation seam. Each `respond`
// is one structured provider call returning a ForgeAnswererStep.
export function wrapProviderAnswerer(
  adapter: AnswererAdapter<ForgeAnswererStepOutput>,
  _options: WrapProviderAnswererOptions = {},
): ForgeConversationAnswerer {
  const jsonSchema = renderAnswererJsonSchema(ForgeAnswererStepSchema);
  return {
    async respond(context: ForgeConversationContext): Promise<ForgeAnswererStep> {
      const output = await adapter.runAnswerer({
        prompt: buildForgePrompt(context),
        outputSchema: {
          name: STEP_SCHEMA_NAME,
          jsonSchema,
          parse: (value) => ForgeAnswererStepSchema.parse(value),
        },
      });
      return normalizeStep(output);
    },
  };
}

// Filters the provider's tool request down to the read family so a model that
// ignores the no-write constraint can never drive a mutation through Forge.
function normalizeStep(step: ForgeAnswererStepOutput): ForgeAnswererStep {
  if (step.kind === "final") {
    return step;
  }
  const readCalls = step.toolCalls.filter((call): call is ForgeReadToolCall => isReadToolName(call.tool));
  return { kind: "tools", toolCalls: readCalls };
}
