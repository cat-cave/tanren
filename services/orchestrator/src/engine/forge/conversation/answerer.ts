// P3-0010: the conversation answerer implementations.
//
//   - `ForgeAnswererStepSchema`   — the strict JSON contract the provider
//     returns each step (request read tools OR finalize a ForgeAnswer).
//   - `wrapProviderAnswerer`      — adapts a P3-0012 AnswererAdapter (Claude /
//     Codex, resolved via adapterSelector) into a ForgeConversationAnswerer.
//   - `createFakeForgeAnswerer`   — a deterministic, scripted answerer for
//     tests so no test hits a real provider.

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
  ForgeReadToolCall
} from "./types.js";

// The provider returns this discriminated union each step. We re-use the
// existing ForgeToolCall union for the tool variant but reject non-read tools
// at the engine boundary (defence in depth; the prompt also forbids them).
export const ForgeAnswererStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tools"), toolCalls: z.array(ForgeToolCall).min(1) }).strict(),
  z.object({ kind: z.literal("final"), answer: ForgeAnswer }).strict()
]);

export type ForgeAnswererStepOutput = z.infer<typeof ForgeAnswererStepSchema>;

const STEP_SCHEMA_NAME = "tanren.forge_conversation_step.v1";

export interface WrapProviderAnswererOptions {
  // Bounds each provider call. Defaults to 120s — Forge conversation answers
  // are interactive, so we keep the ceiling tighter than a writer/auditor.
  timeoutMs?: number;
}

// Adapts a provider AnswererAdapter into the conversation seam. Each `respond`
// is one structured provider call returning a ForgeAnswererStep.
export function wrapProviderAnswerer(
  adapter: AnswererAdapter<ForgeAnswererStepOutput>,
  options: WrapProviderAnswererOptions = {}
): ForgeConversationAnswerer {
  const jsonSchema = renderAnswererJsonSchema(ForgeAnswererStepSchema);
  return {
    async respond(context: ForgeConversationContext): Promise<ForgeAnswererStep> {
      const output = await adapter.runAnswerer({
        prompt: buildForgePrompt(context),
        timeoutMs: options.timeoutMs ?? 120_000,
        outputSchema: {
          name: STEP_SCHEMA_NAME,
          jsonSchema,
          parse: (value) => ForgeAnswererStepSchema.parse(value)
        }
      });
      return normalizeStep(output);
    }
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

// ---------------------------------------------------------------------------
// Fake answerer — scripted steps for tests. Each entry in `script` is returned
// in order on successive `respond` calls; the last entry repeats if the engine
// asks again. This lets a test express "read a run, then finalize" without a
// provider.
// ---------------------------------------------------------------------------

export interface FakeForgeAnswererOptions {
  script: ForgeAnswererStep[];
  // Optional spy: invoked with each context the engine passes, so a test can
  // assert the answerer saw the tool results / history it expected.
  onRespond?: (context: ForgeConversationContext) => void;
}

export function createFakeForgeAnswerer(options: FakeForgeAnswererOptions): ForgeConversationAnswerer {
  let index = 0;
  return {
    async respond(context: ForgeConversationContext): Promise<ForgeAnswererStep> {
      options.onRespond?.(context);
      const step = options.script[Math.min(index, options.script.length - 1)];
      index += 1;
      if (step === undefined) {
        return { kind: "final", answer: { body: "(no script)", attentionItems: [], insights: [], prompts: [] } };
      }
      return step.kind === "tools" ? normalizeStep(step) : step;
    }
  };
}
