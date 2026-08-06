import { createHash } from "node:crypto";

/** Default freshness window for parsed branch-protection/rules proof. */
export const GITHUB_PROTECTION_PROOF_CACHE_TTL_MS = 5_000;
/** A caller may shorten the window, but proof must never be cached longer than this bound. */
export const MAX_GITHUB_PROTECTION_PROOF_CACHE_TTL_MS = 60_000;
export const DEFAULT_GITHUB_API_ENDPOINT = "https://api.github.com";

export interface GitHubProtectionProof {
  contexts: string[] | undefined;
  appIds: Record<string, number>;
}

/** Optional per-call identity dimensions for the proof cache. */
export interface GitHubProtectionProofContext {
  /** Stable org/tenant/credential scope when the caller has one. */
  authorizationIdentity?: string;
  /** The forge API base URL or another stable endpoint identity. */
  endpointIdentity?: string;
}

interface CacheEntry {
  value: GitHubProtectionProof | undefined;
  expiresAt: number;
}

/**
 * Build a non-secret cache key for a proof request. The token fingerprint is kept
 * separately from the stable authorization identity so a refreshed token always
 * starts a new cache generation without retaining the bearer token in memory as a
 * map key.
 */
export function githubProtectionProofCacheKey(input: {
  owner: string;
  name: string;
  baseBranch: string;
  token: string;
  authorizationIdentity?: string;
  endpointIdentity?: string;
}): string {
  return JSON.stringify({
    repository: { owner: input.owner, name: input.name },
    baseBranch: input.baseBranch,
    authorizationIdentity: input.authorizationIdentity ?? "token",
    tokenFingerprint: githubTokenFingerprint(input.token),
    endpoint: canonicalEndpoint(input.endpointIdentity ?? DEFAULT_GITHUB_API_ENDPOINT),
  });
}

/** A one-way fingerprint used only to distinguish effective bearer tokens. */
export function githubTokenFingerprint(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function canonicalEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/u, "");
}

/**
 * Process-local TTL + single-flight cache for authoritative protection proof.
 * Only a resolved proof is inserted; rejected or ambiguous reads never enter the
 * cache and therefore cannot become sufficient evidence on a later poll.
 */
export class GitHubProtectionProofCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<GitHubProtectionProof | undefined>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    const ttlMs = options.ttlMs ?? GITHUB_PROTECTION_PROOF_CACHE_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_GITHUB_PROTECTION_PROOF_CACHE_TTL_MS) {
      throw new RangeError(
        `GitHub protection proof cache TTL must be > 0 and <= ${MAX_GITHUB_PROTECTION_PROOF_CACHE_TTL_MS}ms`,
      );
    }
    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
  }

  async read(
    key: string,
    proof: () => Promise<GitHubProtectionProof | undefined>,
  ): Promise<GitHubProtectionProof | undefined> {
    const cached = this.entries.get(key);
    const now = this.now();
    if (cached !== undefined && cached.expiresAt > now) {
      return cloneProof(cached.value);
    }
    if (cached !== undefined) this.entries.delete(key);

    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing.then(cloneProof);

    const promise = Promise.resolve()
      .then(proof)
      .then((value) => {
        this.entries.set(key, { value: cloneProof(value), expiresAt: this.now() + this.ttlMs });
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise.then(cloneProof);
  }
}

function cloneProof(value: GitHubProtectionProof | undefined): GitHubProtectionProof | undefined {
  if (value === undefined) return undefined;
  return {
    contexts: value.contexts?.slice(),
    appIds: { ...value.appIds },
  };
}
