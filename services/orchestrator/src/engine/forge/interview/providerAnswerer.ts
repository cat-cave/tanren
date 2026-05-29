// P3-0015: the provider-backed interview answerer (the real LLM seam).
//
// Adapts a P3-0012 AnswererAdapter into the `InterviewAnswerer` seam, mirroring
// P3-0010's `wrapProviderAnswerer`. Each `ask` is one structured provider call
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

export interface WrapProviderInterviewAnswererOptions {
  // Bounds each provider call. Defaults to 120s — interview rounds are
  // interactive, matching the conversation answerer ceiling.
  timeoutMs?: number;
}

export function wrapProviderInterviewAnswerer(
  adapter: AnswererAdapter<InterviewRoundOutputType>,
  options: WrapProviderInterviewAnswererOptions = {},
): InterviewAnswerer {
  const jsonSchema = renderAnswererJsonSchema(InterviewRoundOutput);
  return {
    async ask(context: InterviewAnswererContext): Promise<InterviewRoundOutputType> {
      return adapter.runAnswerer({
        prompt: buildInterviewPrompt(context),
        timeoutMs: options.timeoutMs ?? 120_000,
        outputSchema: {
          name: STEP_SCHEMA_NAME,
          jsonSchema,
          parse: (value) => InterviewRoundOutput.parse(value),
        },
      });
    },
  };
}
