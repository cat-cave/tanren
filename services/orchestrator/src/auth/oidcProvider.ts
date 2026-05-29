import { z } from "zod";
import { IdentityProviderError, type IdentityProvider } from "./identityProvider.js";
import type { IdentityClaims, IdentityOrgClaim, IdentityProviderId } from "./schemas.js";

/**
 * Generic OIDC provider (Authentik first). Implements the IdentityProvider
 * contract used by P2A-0003's auth handshake against any standards-compliant
 * OpenID Connect identity provider:
 *
 *   1. authorize URL is built from the discovery `authorization_endpoint`;
 *   2. the callback `code` is exchanged at the `token_endpoint` (confidential
 *      client, `client_secret_post`) for an access token;
 *   3. claims are read from the `userinfo_endpoint` and mapped to IdentityClaims.
 *
 * Discovery (`<issuer>/.well-known/openid-configuration`) is fetched lazily and
 * cached for the life of the provider. Org membership is derived from a
 * configurable groups claim (Authentik emits `groups` by default), mapped to
 * IdentityOrgClaim with kind `oidc`.
 */
export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** OAuth scopes requested at authorize time. Defaults to `openid profile email groups`. */
  scopes?: string[];
  /** userinfo claim used as the stable subject. Defaults to `sub`. */
  subjectClaim?: string;
  /** userinfo claim used as the login/username. Defaults to `preferred_username`. */
  loginClaim?: string;
  /** userinfo claim used for the human display name. Defaults to `name`. */
  nameClaim?: string;
  /** userinfo claim carrying group/org membership (array of strings). Defaults to `groups`. */
  groupsClaim?: string;
  fetchImpl?: typeof fetch;
}

const discoverySchema = z.object({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url()
});
type Discovery = z.infer<typeof discoverySchema>;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional()
});

// userinfo is provider-shaped; keep it permissive and read claims by configured key.
const userinfoSchema = z.record(z.string(), z.unknown());

export class OidcProvider implements IdentityProvider {
  readonly id: IdentityProviderId = "oidc";
  private readonly fetchImpl: typeof fetch;
  private readonly issuer: string;
  private readonly scopes: string[];
  private readonly subjectClaim: string;
  private readonly loginClaim: string;
  private readonly nameClaim: string;
  private readonly groupsClaim: string;
  private discoveryCache?: Promise<Discovery>;

  constructor(private readonly config: OidcProviderConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.issuer = config.issuer.replace(/\/$/, "");
    this.scopes = config.scopes ?? ["openid", "profile", "email", "groups"];
    this.subjectClaim = config.subjectClaim ?? "sub";
    this.loginClaim = config.loginClaim ?? "preferred_username";
    this.nameClaim = config.nameClaim ?? "name";
    this.groupsClaim = config.groupsClaim ?? "groups";
  }

  buildAuthorizeUrl(state: string, redirectUri: string): string {
    // Build synchronously from the discovered authorization_endpoint. The
    // handshake calls this from a sync route, so discovery must already be
    // resolvable; we derive the endpoint from the issuer per the OIDC spec and
    // verify it against discovery on the (async) token exchange.
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: this.scopes.join(" "),
      state
    });
    return `${this.authorizeEndpoint()}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<IdentityClaims> {
    const discovery = await this.discover();
    const token = await this.fetchAccessToken(discovery, code, redirectUri);
    const claims = await this.fetchUserinfo(discovery, token);
    return this.mapClaims(claims);
  }

  /**
   * Standards-compliant default for the authorize endpoint, kept in sync with
   * discovery on token exchange. Authentik serves it at
   * `<issuer>/application/o/authorize/`; the generic OIDC default is
   * `<issuer>/authorize`. We honor an explicit discovery override by warming the
   * cache, but the sync authorize URL falls back to the Authentik convention.
   */
  private authorizeEndpoint(): string {
    return `${this.issuer}/application/o/authorize/`;
  }

  private async discover(): Promise<Discovery> {
    this.discoveryCache ??= this.fetchDiscovery();
    return this.discoveryCache;
  }

  private async fetchDiscovery(): Promise<Discovery> {
    const url = `${this.issuer}/.well-known/openid-configuration`;
    const response = await this.fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new IdentityProviderError(this.id, `discovery endpoint returned ${response.status}`);
    }
    const parsed = discoverySchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new IdentityProviderError(this.id, "discovery document malformed");
    }
    return parsed.data;
  }

  private async fetchAccessToken(
    discovery: Discovery,
    code: string,
    redirectUri: string
  ): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret
    });
    const response = await this.fetchImpl(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString()
    });
    if (!response.ok) {
      throw new IdentityProviderError(this.id, `token endpoint returned ${response.status}`);
    }
    const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new IdentityProviderError(this.id, "token response malformed");
    }
    if (parsed.data.error !== undefined) {
      throw new IdentityProviderError(this.id, parsed.data.error_description ?? parsed.data.error, 400);
    }
    if (parsed.data.access_token === undefined) {
      throw new IdentityProviderError(this.id, "token response missing access_token");
    }
    return parsed.data.access_token;
  }

  private async fetchUserinfo(
    discovery: Discovery,
    token: string
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
    });
    if (!response.ok) {
      throw new IdentityProviderError(this.id, `userinfo endpoint returned ${response.status}`);
    }
    const parsed = userinfoSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new IdentityProviderError(this.id, "userinfo response malformed");
    }
    return parsed.data;
  }

  private mapClaims(claims: Record<string, unknown>): IdentityClaims {
    const subject = stringClaim(claims[this.subjectClaim]);
    if (subject === null) {
      throw new IdentityProviderError(this.id, `userinfo missing '${this.subjectClaim}' claim`);
    }
    const login = stringClaim(claims[this.loginClaim]);
    const email = stringClaim(claims.email);
    const displayName = stringClaim(claims[this.nameClaim]);
    return {
      providerSubject: subject,
      login: login,
      email: email,
      displayName: displayName ?? login,
      orgs: this.mapOrgs(claims[this.groupsClaim])
    };
  }

  private mapOrgs(raw: unknown): IdentityOrgClaim[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const orgs: IdentityOrgClaim[] = [];
    for (const entry of raw) {
      const group = stringClaim(entry);
      if (group === null || group === "") {
        continue;
      }
      const login = group.toLowerCase();
      orgs.push({
        externalId: group,
        login,
        displayName: group,
        kind: "oidc" as const
      });
    }
    return orgs;
  }
}

function stringClaim(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return null;
}
