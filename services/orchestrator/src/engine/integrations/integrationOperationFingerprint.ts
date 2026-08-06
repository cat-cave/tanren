import { createHash } from "node:crypto";
import type { PrincipalCandidate } from "../contracts/integrationAuthority.js";

function sha256(parts: readonly unknown[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex")}`;
}

/**
 * Bind an idempotency key to the immutable request, including credential bytes.
 * Only the digest is persisted; tokens never cross the request/staging boundary.
 */
export function integrationRequestFingerprint(input: {
  orgId: string;
  providerKind: string;
  operationKind: "link" | "rotate";
  connectionId?: string;
  providerEndpoint?: string;
  actorId: string;
  credential: string;
}): string {
  // Durable operations emitted before endpoint binding used this exact v1 tuple.
  // Preserve it for endpoint-less providers so retries resume, not re-effect.
  if (input.providerEndpoint === undefined)
    return sha256([
      "tanren.integration-operation.v1",
      input.orgId,
      input.providerKind,
      input.operationKind,
      input.connectionId ?? null,
      input.actorId,
      input.credential,
    ]);
  return sha256([
    "tanren.integration-operation.v2",
    input.orgId,
    input.providerKind,
    input.operationKind,
    input.connectionId ?? null,
    input.providerEndpoint,
    input.actorId,
    input.credential,
  ]);
}

/** Bind a durable reservation to the exact provider-verified principal result. */
export function principalVerificationFingerprint(input: {
  principal: PrincipalCandidate;
  authKind: string;
  scopes: readonly string[];
  expiresAt?: string;
}): string {
  return sha256([
    "tanren.integration-verification.v1",
    input.principal.providerPrincipalId,
    input.principal.principalKind,
    input.principal.displayName,
    Object.entries(input.principal.metadata).sort(([left], [right]) => left.localeCompare(right)),
    input.authKind,
    [...new Set(input.scopes)].sort(),
    input.expiresAt ?? null,
  ]);
}
