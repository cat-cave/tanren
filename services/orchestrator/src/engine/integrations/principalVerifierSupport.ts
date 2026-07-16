import type { PrincipalVerificationPermit } from "../contracts/integrationAuthority.js";
import { assertPrincipalVerificationPermit } from "./integrationAuthorityImpl.js";
import type { IntegrationSecretStore, StagedSecretHandle } from "../contracts/integrationSecretStore.js";

export type FetchImpl = typeof fetch;

export class PrincipalProviderUnavailableError extends Error {
  public override readonly name = "PrincipalProviderUnavailableError";

  constructor(
    public readonly reason: string,
    public readonly retryAfter?: string,
  ) {
    super(reason);
  }
}

export function providerUnavailable(response: Response, reason: string) {
  const retryAfter = response.headers.get("retry-after")?.trim();
  return {
    status: "unavailable" as const,
    reason,
    ...(retryAfter === undefined || retryAfter === "" ? {} : { retryAfter: retryAfter.slice(0, 128) }),
  };
}

export function unavailableError(response: Response, reason: string): PrincipalProviderUnavailableError {
  const unavailable = providerUnavailable(response, reason);
  return new PrincipalProviderUnavailableError(unavailable.reason, unavailable.retryAfter);
}

export function principalMetadata(entries: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function parseProviderScopes(header: string | null): string[] {
  if (header === null || header.trim() === "") return [];
  return [
    ...new Set(
      header
        .split(/[,\s]+/u)
        .map((scope) => scope.trim())
        .filter((scope) => scope !== ""),
    ),
  ];
}

export async function readStagedToken(
  permit: PrincipalVerificationPermit,
  staged: StagedSecretHandle,
  secrets: IntegrationSecretStore,
): Promise<string> {
  assertPrincipalVerificationPermit(permit);
  if (staged.operationId !== permit.operationId || staged.handle !== permit.stagedSecretHandle) {
    throw new Error("staged credential handle does not match verification permit");
  }
  const reader = secrets as IntegrationSecretStore & {
    readStagedForPermit?(permit: PrincipalVerificationPermit, staged: StagedSecretHandle): Promise<string>;
  };
  if (typeof reader.readStagedForPermit !== "function") {
    throw new TypeError("integration secret store cannot expose staged credential to verifier");
  }
  return reader.readStagedForPermit(permit, staged);
}
