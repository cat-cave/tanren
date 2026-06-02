// TEST FIXTURE ONLY (P1c). Scripted fake Forge conversation answerer — returns
// pre-canned steps so a test can drive the conversation engine ("read a run,
// then finalize") without a provider. It MUST NOT be constructed by any
// production/runtime path; production resolves a real provider answerer. Moved
// out of the production conversation answerer module so the §8a arch-lint keeps
// `Fake*` answerer constructors out of src/.

import { isReadToolName } from "../../../src/engine/forge/index.js";
import type {
  ForgeAnswererStep,
  ForgeConversationAnswerer,
  ForgeConversationContext,
  ForgeReadToolCall,
} from "../../../src/engine/forge/index.js";

export interface FakeForgeAnswererOptions {
  script: ForgeAnswererStep[];
  // Optional spy: invoked with each context the engine passes, so a test can
  // assert the answerer saw the tool results / history it expected.
  onRespond?: (context: ForgeConversationContext) => void;
}

// Each entry in `script` is returned in order on successive `respond` calls; the
// last entry repeats if the engine asks again.
export function createFakeForgeAnswerer(options: FakeForgeAnswererOptions): ForgeConversationAnswerer {
  let index = 0;
  return {
    async respond(context: ForgeConversationContext): Promise<ForgeAnswererStep> {
      options.onRespond?.(context);
      const step = options.script[Math.min(index, options.script.length - 1)];
      index += 1;
      if (step === undefined) {
        return {
          kind: "final",
          answer: { body: "(no script)", attentionItems: [], insights: [], prompts: [] },
        };
      }
      return step.kind === "tools" ? normalizeStep(step) : step;
    },
  };
}

// Mirrors the engine boundary: a model that ignores the no-write constraint can
// never drive a mutation through Forge, so the fake filters to the read family.
function normalizeStep(step: ForgeAnswererStep): ForgeAnswererStep {
  if (step.kind === "final") {
    return step;
  }
  const readCalls = step.toolCalls.filter((call): call is ForgeReadToolCall => isReadToolName(call.tool));
  return { kind: "tools", toolCalls: readCalls };
}
