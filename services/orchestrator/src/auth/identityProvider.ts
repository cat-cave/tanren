import type { IdentityClaims, IdentityProviderId } from "./schemas.js";

export interface IdentityProvider {
  readonly id: IdentityProviderId;
  buildAuthorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<IdentityClaims>;
}

export class IdentityProviderError extends Error {
  constructor(
    readonly providerId: IdentityProviderId,
    message: string,
    readonly statusCode: number = 502
  ) {
    super(`[${providerId}] ${message}`);
  }
}
