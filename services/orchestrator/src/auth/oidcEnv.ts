import { z } from "zod";
import { authentikPresetDefaults } from "./authentikEnv.js";
import { OidcProvider, type OidcProviderConfig } from "./oidcProvider.js";

/**
 * The closed set of known `TANREN_OIDC_PRESET` values. UNSET is the documented
 * generic-OIDC default (no preset). A SET-yet-unknown value (a typo) is a LOUD
 * boot error — never a silent fall-through to generic OIDC, which would run a
 * DIFFERENT claim mapping than the operator intended (the no-silent-fallback
 * boundary: an unknown config value fails loud, it does not degrade to a default).
 */
export const OidcPreset = z.enum(["authentik"]);
export type OidcPreset = z.infer<typeof OidcPreset>;

/**
 * Validate `TANREN_OIDC_PRESET` against the known {@link OidcPreset} enum. UNSET
 * (or blank) → `undefined` (generic OIDC, the documented default). A present but
 * unknown value THROWS, naming the value and the allowed set — a typo must not
 * silently run generic OIDC instead of the intended preset's claim mapping.
 */
function parseOidcPreset(raw: string | undefined): OidcPreset | undefined {
  const value = emptyToUndefined(raw);
  if (value === undefined) {
    return undefined;
  }
  const parsed = OidcPreset.safeParse(value.toLowerCase());
  if (!parsed.success) {
    const allowed = OidcPreset.options.join(", ");
    throw new Error(
      `TANREN_OIDC_PRESET='${value}' is not a known OIDC preset (expected one of: ${allowed}). ` +
        "Unset it to use the generic-OIDC default; a typo must NOT silently run generic OIDC " +
        "instead of the intended preset's claim mapping.",
    );
  }
  return parsed.data;
}

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
    issuer === undefined ||
    issuer === "" ||
    clientId === undefined ||
    clientId === "" ||
    clientSecret === undefined ||
    clientSecret === ""
  ) {
    return undefined;
  }
  const preset = presetDefaults(parseOidcPreset(process.env["TANREN_OIDC_PRESET"]));
  const scopesEnv = emptyToUndefined(process.env["TANREN_OIDC_SCOPES"]);
  return new OidcProvider({
    issuer,
    clientId,
    clientSecret,
    // Explicit env overrides win over preset defaults (which in turn fill in for
    // the generic provider's own built-in defaults when no preset is selected).
    scopes: scopesEnv === undefined ? preset.scopes : scopesEnv.split(/\s+/u).filter(Boolean),
    subjectClaim: emptyToUndefined(process.env["TANREN_OIDC_SUBJECT_CLAIM"]) ?? preset.subjectClaim,
    loginClaim: emptyToUndefined(process.env["TANREN_OIDC_LOGIN_CLAIM"]) ?? preset.loginClaim,
    nameClaim: emptyToUndefined(process.env["TANREN_OIDC_NAME_CLAIM"]) ?? preset.nameClaim,
    groupsClaim: emptyToUndefined(process.env["TANREN_OIDC_GROUPS_CLAIM"]) ?? preset.groupsClaim,
  });
}

type PresetDefaults = Pick<OidcProviderConfig, "scopes" | "subjectClaim" | "loginClaim" | "nameClaim" | "groupsClaim">;

/**
 * Resolve a VALIDATED preset (already checked against the {@link OidcPreset} enum
 * by {@link parseOidcPreset}, so an unknown value never reaches here) to its
 * partial config. `undefined` (no preset) → an empty object, leaving the generic
 * provider's built-in defaults intact (existing generic-OIDC deployments unchanged).
 */
function presetDefaults(name: OidcPreset | undefined): PresetDefaults {
  switch (name) {
    case "authentik":
      return authentikPresetDefaults();
    case undefined:
      return {};
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
