import type { OidcProviderConfig } from "./oidcProvider.js";

/**
 * Authentik OIDC preset (zero-fiddle homelab defaults).
 *
 * The generic {@link OidcProvider} already happens to default to Authentik's
 * claim shape, but those defaults are not contractually pinned to Authentik —
 * a future generic-provider tweak could drift them. This preset makes the
 * Authentik shape explicit and self-documenting so a self-hosted operator only
 * needs to supply issuer + client id/secret. It is selected via
 * `TANREN_OIDC_PRESET=authentik` and threaded through {@link buildOidcProviderFromEnv}.
 *
 * Standard Authentik userinfo claims (with the `openid profile email` + a
 * `groups` scope/mapping):
 *   - `sub`                -> stable subject
 *   - `preferred_username` -> login
 *   - `email`              -> email
 *   - `name`               -> human display name
 *   - `groups`             -> org/group membership (array of strings)
 *
 * Every field stays individually overridable: an explicit `TANREN_OIDC_*`
 * env still wins, the preset only fills the gaps the operator left unset.
 */

/** Default OAuth scopes for Authentik — `groups` surfaces the userinfo groups claim. */
export const AUTHENTIK_SCOPES: readonly string[] = ["openid", "profile", "email", "groups"];

/** Authentik's standard claim-mapping defaults supplied by the preset. */
export const AUTHENTIK_CLAIM_DEFAULTS: Readonly<{
  subjectClaim: string;
  loginClaim: string;
  nameClaim: string;
  groupsClaim: string;
}> = {
  subjectClaim: "sub",
  loginClaim: "preferred_username",
  nameClaim: "name",
  groupsClaim: "groups",
};

/**
 * The Authentik preset defaults, expressed as a partial provider config.
 * `buildOidcProviderFromEnv` layers explicit env overrides on top of this, so
 * any value an operator did not set falls back to the Authentik-correct shape.
 */
export function authentikPresetDefaults(): Pick<
  OidcProviderConfig,
  "scopes" | "subjectClaim" | "loginClaim" | "nameClaim" | "groupsClaim"
> {
  return {
    scopes: [...AUTHENTIK_SCOPES],
    subjectClaim: AUTHENTIK_CLAIM_DEFAULTS.subjectClaim,
    loginClaim: AUTHENTIK_CLAIM_DEFAULTS.loginClaim,
    nameClaim: AUTHENTIK_CLAIM_DEFAULTS.nameClaim,
    groupsClaim: AUTHENTIK_CLAIM_DEFAULTS.groupsClaim,
  };
}
