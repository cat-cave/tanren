// Forge data substrate barrel. The routes, the dashboard, and the LLM author
// all import the typed surface from here.

export {
  ForgeThreadScope,
  ForgeTurnSource,
  ForgeTurnAudience,
  ForgeAuthorKind,
  ForgeThreadRow,
  ForgeTurnRow,
  ForgeThreadCreateInput,
  ForgeTurnAppendInput,
  ForgeAnswer,
} from "./schemas.js";

export { ForgeThreadStore, ForgeThreadAccessDeniedError } from "./threads.js";
export { ForgeTurnStore, actorCanViewAudience } from "./turns.js";

export {
  ForgeProposalStore,
  ForgeProposalStatus,
  ForgeActionProposalRow,
  ProposalNotFoundError,
  ProposalAlreadyDecidedError,
  toolCallForProposal,
  type CreateProposalInput,
} from "./proposals.js";

export {
  decideForgeProposal,
  type ForgeProposalDecisionDeps,
  type ForgeProposalDecisionResult,
  type ForgeWriteToolDispatcher,
} from "./proposalDecision.js";

export * from "./tools/index.js";

// spec-quality contract (workstream 1): the reusable prompt + the spec-validation
// answerer + the `validateEmittedSpecs` gate that every spec-emitter runs before a
// spec lands. WS2's TRIAGE also imports from here.
export * from "./specQuality/index.js";

// thick-Forge LLM conversation backend (the real-LLM answerer for
// operator-driven questions; the templated v0 narration is the fallback).
export * from "./conversation/index.js";

export {
  generateProjectViewNarration,
  generateRunDetailNarration,
  type NarrationInput,
  type NarrationProject,
  type NarrationRun,
  type NarrationInsight,
  type NarrationVelocity,
  type RunDetailNarrationInput,
} from "./narration/v0.js";
