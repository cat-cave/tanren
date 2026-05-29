import { z } from "zod";
import { IdentityProviderError, type IdentityProvider } from "./identityProvider.js";
import type { IdentityClaims, IdentityOrgClaim, IdentityProviderId } from "./schemas.js";

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  scopes?: string[];
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const githubUserSchema = z.object({
  id: z.union([z.number().int(), z.string()]),
  login: z.string().min(1),
  name: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

const githubEmailSchema = z.object({
  email: z.string().min(1),
  primary: z.boolean().optional(),
  verified: z.boolean().optional(),
});

const githubOrgSchema = z.object({
  id: z.union([z.number().int(), z.string()]),
  login: z.string().min(1),
  description: z.string().nullable().optional(),
});

export class GitHubOAuthProvider implements IdentityProvider {
  readonly id: IdentityProviderId = "github_oauth";
  private readonly fetchImpl: typeof fetch;
  private readonly authorizeUrl: string;
  private readonly tokenUrl: string;
  private readonly apiBaseUrl: string;
  private readonly scopes: string[];

  constructor(private readonly config: GitHubOAuthConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.authorizeUrl = config.authorizeUrl ?? "https://github.com/login/oauth/authorize";
    this.tokenUrl = config.tokenUrl ?? "https://github.com/login/oauth/access_token";
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.scopes = config.scopes ?? ["read:user", "user:email", "read:org"];
  }

  buildAuthorizeUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      state,
      scope: this.scopes.join(" "),
      allow_signup: "false",
    });
    return `${this.authorizeUrl}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string): Promise<IdentityClaims> {
    const token = await this.fetchAccessToken(code, redirectUri);
    const [user, email, orgs] = await Promise.all([
      this.fetchUser(token),
      this.fetchPrimaryEmail(token),
      this.fetchOrgs(token),
    ]);
    return {
      providerSubject: String(user.id),
      login: user.login,
      email: email ?? user.email ?? null,
      displayName: user.name ?? user.login,
      orgs,
    };
  }

  private async fetchAccessToken(code: string, redirectUri: string): Promise<string> {
    const response = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
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

  private async fetchUser(token: string): Promise<z.infer<typeof githubUserSchema>> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      throw new IdentityProviderError(this.id, `user endpoint returned ${response.status}`);
    }
    const parsed = githubUserSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      throw new IdentityProviderError(this.id, "user response malformed");
    }
    return parsed.data;
  }

  private async fetchPrimaryEmail(token: string): Promise<string | null> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/user/emails`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      return null;
    }
    const list = z.array(githubEmailSchema).safeParse(await response.json().catch(() => undefined));
    if (!list.success) {
      return null;
    }
    const primary = list.data.find((entry) => entry.primary === true) ?? list.data[0];
    return primary?.email ?? null;
  }

  private async fetchOrgs(token: string): Promise<IdentityOrgClaim[]> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}/user/orgs`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      throw new IdentityProviderError(this.id, `orgs endpoint returned ${response.status}`);
    }
    const list = z.array(githubOrgSchema).safeParse(await response.json().catch(() => undefined));
    if (!list.success) {
      throw new IdentityProviderError(this.id, "orgs response malformed");
    }
    return list.data.map((entry) => ({
      externalId: String(entry.id),
      login: entry.login.toLowerCase(),
      displayName: entry.description ?? entry.login,
      kind: "github_org" as const,
    }));
  }
}
