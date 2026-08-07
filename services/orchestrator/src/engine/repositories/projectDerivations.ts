// Compatibility facade for project-derivation consumers. Identity/receipt
// validation and durable lifecycle writes are separate domains behind this path.
export {
  ProjectDerivationConflictError,
  ProjectDerivationRow,
  projectDerivationFingerprint,
  withProjectDerivationLock,
} from "./projectDerivationContracts.js";
export { ProjectDerivationStore } from "./projectDerivationStore.js";
export {
  buildDerivationOwnership,
  explicitRepositoryMarker,
  repositoryOwnershipMarker,
} from "./projectDerivationReceipts.js";
export type {
  CompleteDirectDerivation,
  CompleteInterviewDerivation,
  CompleteProjectDerivation,
  DecodedDerivationReceipts,
  DerivationKind,
  DerivationOwnershipReceipt,
  ExpectedDerivationIdentity,
} from "./projectDerivationReceipts.js";
export type { DerivationPhase, DerivationStatus } from "./projectDerivationContracts.js";
export { ProjectActivationReadinessBlockedError } from "./activationReadiness.js";
