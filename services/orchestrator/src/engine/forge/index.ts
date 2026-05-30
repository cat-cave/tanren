// P2A-0019 Forge data substrate barrel. Routes (P2A-0019), the Phase 2B
// dashboard, and the Phase 3 LLM author all import the typed surface from
// here.

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

// P3-0010: thick-Forge LLM conversation backend (the Phase 3 swap-in for the
// templated v0 narration on operator-driven questions).
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
