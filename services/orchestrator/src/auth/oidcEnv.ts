import { OidcProvider } from "./oidcProvider.js";

/**
 * Build the OIDC provider from operator env, or `undefined` when it is not
 * configured. All three of issuer + client id + client secret must be set for
 * the provider to register; optional claim/scope overrides let an operator
 * adapt to a non-default IdP without code changes. Kept out of main.ts so the
 * orchestrator entrypoint stays under the 500-line cap.
 */
export function buildOidcProviderFromEnv(): OidcProvider | undefined {
  const issuer = process.env.TANREN_OIDC_ISSUER;
  const clientId = process.env.TANREN_OIDC_CLIENT_ID;
  const clientSecret = process.env.TANREN_OIDC_CLIENT_SECRET;
  if (
    issuer === undefined || issuer === "" ||
    clientId === undefined || clientId === "" ||
    clientSecret === undefined || clientSecret === ""
  ) {
    return undefined;
  }
  const scopes = process.env.TANREN_OIDC_SCOPES;
  return new OidcProvider({
    issuer,
    clientId,
    clientSecret,
    scopes: scopes !== undefined && scopes !== "" ? scopes.split(/\s+/).filter(Boolean) : undefined,
    subjectClaim: emptyToUndefined(process.env.TANREN_OIDC_SUBJECT_CLAIM),
    loginClaim: emptyToUndefined(process.env.TANREN_OIDC_LOGIN_CLAIM),
    nameClaim: emptyToUndefined(process.env.TANREN_OIDC_NAME_CLAIM),
    groupsClaim: emptyToUndefined(process.env.TANREN_OIDC_GROUPS_CLAIM)
  });
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
