// Compatibility facade for the project-derivation receipt API. Schema catalog and
// envelope codecs are separate domains while this path preserves every export.
export {
  BootstrapSchema,
  completeDerivationReceipts,
  DerivationKindSchema,
  DerivationOwnershipReceiptSchema,
} from "./projectDerivationReceiptSchemas.js";
export type {
  CompleteDirectDerivation,
  CompleteInterviewDerivation,
  CompleteProjectDerivation,
  DecodedDerivationReceipts,
  DerivationKind,
  DerivationOwnershipReceipt,
  DerivationReceiptKey,
  DerivationReceiptValueByKey,
} from "./projectDerivationReceiptSchemas.js";
export {
  buildDerivationOwnership,
  canonicalDerivationJson,
  canonicalizeDerivation,
  decodeDerivationReceipts,
  derivationJson,
  DerivationReceiptValidationError,
  encodeResultReceipt,
  encodeTemplateReceipt,
  explicitRepositoryMarker,
  repositoryOwnershipMarker,
} from "./projectDerivationReceiptCodec.js";
export type { ExpectedDerivationIdentity } from "./projectDerivationReceiptCodec.js";
