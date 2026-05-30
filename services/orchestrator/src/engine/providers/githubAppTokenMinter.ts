// P3-0003: GitHub App installation-token minter.
//
// Flow (GitHub's documented App auth):
//   1. Sign a short-lived (~10 min) RS256 JWT with the App private key. The JWT
//      `iss` is the numeric App id. This is the *app* token — it can only call
//      `/app/**` endpoints.
//   2. Exchange it at `POST /app/installations/{id}/access_tokens` for an
//      *installation* token (~1 h TTL) scoped to that installation's repos.
//   3. Cache the installation token by installation id and reuse it until it is
//      within an expiry safety window; mint a fresh one before expiry, or on a
//      401 (see `FetchGitHubHttpClient`'s token-supplier retry).
//
// The App private key NEVER leaves Vault-derived memory: it is read via the
// credential loader, used to sign in-process, and never logged. Installation
// tokens are kept only in this in-memory cache.

import { createSign } from "node:crypto";
import { loadGithubAppCredential } from "../credentials/githubApp.js";
import type { SecretStore } from "../contracts/secretStore.js";

/** Mint a fresh installation token this many ms before the cached one expires. */
const EXPIRY_SAFETY_WINDOW_MS = 60_000;
/** App JWT lifetime; GitHub rejects anything over 10 minutes. */
const APP_JWT_TTL_SECONDS = 540;

export interface GithubInstallationTokenRequest {
  installationId: string;
  credentialRef: string;
}

export interface MintedInstallationToken {
  token: string;
  expiresAt: Date;
}

interface CacheEntry {
  token: string;
  expiresAt: number;
}

export interface GithubAppTokenMinterOptions {
  secrets: SecretStore;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock for deterministic tests (ms epoch). */
  now?: () => number;
}

export class GithubAppTokenMinter {
  private readonly secrets: SecretStore;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<MintedInstallationToken>>();

  constructor(options: GithubAppTokenMinterOptions) {
    this.secrets = options.secrets;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Returns a cached installation token if still fresh, else mints a new one. */
  async getInstallationToken(request: GithubInstallationTokenRequest): Promise<string> {
    const cached = this.cache.get(request.installationId);
    if (cached !== undefined && cached.expiresAt - EXPIRY_SAFETY_WINDOW_MS > this.now()) {
      return cached.token;
    }
    const minted = await this.mint(request);
    return minted.token;
  }

  /** Forces a fresh mint (used on a 401), bypassing and replacing the cache. */
  async refreshInstallationToken(request: GithubInstallationTokenRequest): Promise<string> {
    this.cache.delete(request.installationId);
    const minted = await this.mint(request);
    return minted.token;
  }

  private async mint(request: GithubInstallationTokenRequest): Promise<MintedInstallationToken> {
    const existing = this.inflight.get(request.installationId);
    if (existing !== undefined) {
      return existing;
    }
    const promise = this.mintUncached(request).finally(() => {
      this.inflight.delete(request.installationId);
    });
    this.inflight.set(request.installationId, promise);
    return promise;
  }

  private async mintUncached(request: GithubInstallationTokenRequest): Promise<MintedInstallationToken> {
    const credential = await loadGithubAppCredential(this.secrets, request.credentialRef);
    const jwt = signAppJwt(credential.appId, credential.privateKeyPem, Math.floor(this.now() / 1000));
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/app/installations/${encodeURIComponent(request.installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (response.status !== 201) {
      throw new Error(`GitHub App installation token mint failed: HTTP ${response.status}`);
    }
    const body = (await response.json().catch(() => {})) as { token?: unknown; expires_at?: unknown } | undefined;
    if (body === undefined || typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new Error("GitHub App installation token response malformed");
    }
    const expiresAt = new Date(body.expires_at);
    this.cache.set(request.installationId, { token: body.token, expiresAt: expiresAt.getTime() });
    return { token: body.token, expiresAt };
  }
}

/** Signs an RS256 GitHub App JWT. Exported for unit testing. */
export function signAppJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // `iat` is backdated 30s to tolerate minor clock skew, per GitHub guidance.
  const payload = base64Url(
    JSON.stringify({
      iat: nowSeconds - 30,
      exp: nowSeconds + APP_JWT_TTL_SECONDS,
      iss: appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
