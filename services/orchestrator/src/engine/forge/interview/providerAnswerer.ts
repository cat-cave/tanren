// the provider-backed interview answerer (the real LLM seam).
//
// Adapts a AnswererAdapter into the `InterviewAnswerer` seam, mirroring
// the conversation answerer's `wrapProviderAnswerer`. Each `ask` is one structured provider call
// returning an `InterviewRoundOutput` (the next question + capture delta).
// Production wires this; tests use the fake/deterministic answerers so no test
// hits a provider.

import { renderAnswererJsonSchema } from "../../answerers/schemas/index.js";
import type { AnswererAdapter } from "../../providers/types.js";
import { buildInterviewPrompt } from "./prompt.js";
import {
  InterviewRoundOutput,
  type InterviewAnswerer,
  type InterviewAnswererContext,
  type InterviewRoundOutput as InterviewRoundOutputType,
} from "./types.js";

const STEP_SCHEMA_NAME = "tanren.vision_interview_round.v1";

// No bounding option remains: each provider answerer call is governed by the agent
// ActivityWatchdog (output-driven, never a wall-clock kill) the adapter constructs.
export type WrapProviderInterviewAnswererOptions = Record<never, never>;

export function wrapProviderInterviewAnswerer(
  adapter: AnswererAdapter<InterviewRoundOutputType>,
  _options: WrapProviderInterviewAnswererOptions = {},
): InterviewAnswerer {
  const jsonSchema = renderAnswererJsonSchema(InterviewRoundOutput);
  return {
    async ask(context: InterviewAnswererContext): Promise<InterviewRoundOutputType> {
      return adapter.runAnswerer({
        prompt: buildInterviewPrompt(context),
        outputSchema: {
          name: STEP_SCHEMA_NAME,
          jsonSchema,
          parse: (value) => InterviewRoundOutput.parse(value),
        },
      });
    },
  };
}
