import { authentikPresetDefaults } from "./authentikEnv.js";
import { OidcProvider, type OidcProviderConfig } from "./oidcProvider.js";

/**
 * Build the OIDC provider from operator env, or `undefined` when it is not
 * configured. All three of issuer + client id + client secret must be set for
 * the provider to register; optional claim/scope overrides let an operator
 * adapt to a non-default IdP without code changes. Kept out of main.ts so the
 * orchestrator entrypoint stays under the 500-line cap.
 *
 * `TANREN_OIDC_PRESET=authentik` selects the turnkey Authentik preset: it fills
 * Authentik's standard claim shape (`preferred_username` -> login, `name` ->
 * display name, `groups` -> orgs) and the `openid profile email groups` scopes
 * by default, so a homelab operator only supplies issuer + client id/secret.
 * Every preset value stays overridable — an explicit `TANREN_OIDC_*` env always
 * wins; the preset only fills the gaps the operator left unset. With no preset,
 * the generic provider defaults are used (behavior unchanged).
 */
export function buildOidcProviderFromEnv(): OidcProvider | undefined {
  const issuer = process.env["TANREN_OIDC_ISSUER"];
  const clientId = process.env["TANREN_OIDC_CLIENT_ID"];
  const clientSecret = process.env["TANREN_OIDC_CLIENT_SECRET"];
  if (
    issuer === undefined || issuer === "" ||
    clientId === undefined || clientId === "" ||
    clientSecret === undefined || clientSecret === ""
  ) {
    return undefined;
  }
  const preset = presetDefaults(emptyToUndefined(process.env["TANREN_OIDC_PRESET"]));
  const scopesEnv = emptyToUndefined(process.env["TANREN_OIDC_SCOPES"]);
  return new OidcProvider({
    issuer,
    clientId,
    clientSecret,
    // Explicit env overrides win over preset defaults (which in turn fill in for
    // the generic provider's own built-in defaults when no preset is selected).
    scopes: scopesEnv !== undefined ? scopesEnv.split(/\s+/).filter(Boolean) : preset.scopes,
    subjectClaim: emptyToUndefined(process.env["TANREN_OIDC_SUBJECT_CLAIM"]) ?? preset.subjectClaim,
    loginClaim: emptyToUndefined(process.env["TANREN_OIDC_LOGIN_CLAIM"]) ?? preset.loginClaim,
    nameClaim: emptyToUndefined(process.env["TANREN_OIDC_NAME_CLAIM"]) ?? preset.nameClaim,
    groupsClaim: emptyToUndefined(process.env["TANREN_OIDC_GROUPS_CLAIM"]) ?? preset.groupsClaim
  });
}

type PresetDefaults = Pick<
  OidcProviderConfig,
  "scopes" | "subjectClaim" | "loginClaim" | "nameClaim" | "groupsClaim"
>;

/**
 * Resolve the named preset to a partial config. Unknown/empty presets resolve
 * to an empty object, leaving the generic provider's built-in defaults intact
 * (so existing generic-OIDC deployments are byte-for-byte unchanged).
 */
function presetDefaults(name: string | undefined): PresetDefaults {
  if (name !== undefined && name.toLowerCase() === "authentik") {
    return authentikPresetDefaults();
  }
  return {};
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
