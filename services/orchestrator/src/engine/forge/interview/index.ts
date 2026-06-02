// P3-0015 greenfield onboarding: vision-interview engine barrel.
//
// The multi-round Forge vision interview (round → accumulate capture) and the
// completion derivation (capture → project + personas/behaviors/milestones/
// specs via the P2A-0018/0013 paths). The interview route imports `runRound` +
// `deriveFromCapture` and wires the provider answerer; tests inject a fixture.

export {
  runRound,
  deriveFromCapture,
  emptyCapture,
  DEFAULT_TOTAL_ROUNDS,
  type InterviewEngineDeps,
  type RunRoundInput,
  type RunRoundResult,
  type DeriveFromCaptureInput,
  type DeriveResult,
} from "./engine.js";

export { wrapProviderInterviewAnswerer, type WrapProviderInterviewAnswererOptions } from "./providerAnswerer.js";
export { buildInterviewPrompt } from "./prompt.js";
export { mergeCapture } from "./capture.js";

export {
  InterviewCapture,
  InterviewRoundOutput,
  InterviewSuggestion,
  CaptureIdentity,
  CapturePersona,
  CaptureBehavior,
  CaptureInterface,
  CaptureArchitectureLine,
  type InterviewAnswerer,
  type InterviewAnswererContext,
} from "./types.js";
