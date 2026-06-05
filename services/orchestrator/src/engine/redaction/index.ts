// Single import surface for the redaction layer. Callers wire
// route handlers to `redactEventPayload` + `emitRedactionAudit`; everything
// else (scope policy, marker shape, high-entropy heuristic) is exported
// here for tests and adjacent surfaces (notifications dispatch, the read
// run-detail API) that need to apply the same redaction discipline.

export {
  AccessScopeOrder,
  canViewRaw,
  describeRequiredScope,
  hasElevatedScope,
  sensitivityToRequiredScopes,
} from "./scopes.js";

export {
  redactEventPayload,
  isRedactionMarker,
  type RedactionInput,
  type RedactionMarker,
  type RedactionOutput,
} from "./serializer.js";

export {
  containsCredentialSubstring,
  looksLikeCredential,
  shannonEntropyBitsPerChar,
  type HighEntropyOptions,
} from "./highEntropy.js";

export { emitRedactionAudit, type RedactionAuditInput } from "./audit.js";
