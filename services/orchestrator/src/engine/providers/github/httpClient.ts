import { setTimeout as sleepFor } from "node:timers/promises";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../github.js";
import {
  buildErrorDetail,
  GitHubOutageError,
  headerGetter,
  isTransientStatus,
  rateLimitBackoffMs,
  transientBackoffMs,
  transientFixedPointReached,
} from "../githubRetry.js";

// The rate-limit + transient-5xx classification/backoff helpers live in githubRetry.ts.

export interface FetchGitHubHttpClientOptions {
  apiBaseUrl?: string;
  /** Stable identity for caches; defaults to the configured API base URL. */
  endpointIdentity?: string;
  fetchImpl?: typeof fetch;
  /** Test seam: sleep used between rate-limit AND transient-5xx retries. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock seam (epoch ms) for computing the wait from `X-RateLimit-Reset`. */
  now?: () => number;
}

export class FetchGitHubHttpClient implements GitHubHttpClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  readonly endpointIdentity: string;

  constructor(opts: FetchGitHubHttpClientOptions = {}) {
    this.apiBaseUrl = opts.apiBaseUrl ?? "https://api.github.com";
    this.endpointIdentity = opts.endpointIdentity ?? this.apiBaseUrl;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => sleepFor(ms));
    this.now = opts.now ?? (() => Date.now());
  }

  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    let token = input.token;
    let refreshed = false;
    // TIMEOUT-ERADICATION (feedback_no_timeouts_progress_based, BINDING): NO fixed retry COUNT.
    // Transients retry while making progress and surface only at a saturated fixed point.
    // Rate-limit and gateway signature streams remain independent, so a 503 burst never
    // denies a later 429 its honored `Retry-After`. The 401 re-mint stays one-shot.
    const transientSignatures: string[] = [];
    const rateLimitSignatures: string[] = [];
    const retryTransient = input.retryTransient !== false;
    const retryRateLimit = input.retryRateLimit !== false;
    for (;;) {
      let response: GitHubHttpResponse;
      try {
        response = await this.send(input.path, input.method, token, input.body);
      } catch (error) {
        // A TRANSPORT failure (fetch threw: connection reset / DNS / timeout). It is transient
        // by nature (no HTTP status) — retry on transient indefinitely while it makes progress,
        // surfacing the underlying throw LOUDLY only when the transport error is non-converging
        // (a proven, sustained outage). A non-idempotent write (retryTransient=false) never
        // auto-retries a throw (the request may have applied server-side).
        if (!retryTransient) {
          throw error;
        }
        transientSignatures.push("transport");
        if (transientFixedPointReached(transientSignatures)) {
          throw error;
        }
        await this.sleep(transientBackoffMs(transientSignatures.length - 1));
        continue;
      }
      // 401 with a token supplier: re-mint once and retry (behavior).
      if (response.status === 401 && input.refreshToken !== undefined && !refreshed) {
        refreshed = true;
        token = await input.refreshToken();
        continue;
      }
      // Rate limits own an independent convergence stream and precede 403 force-mint.
      // Durable intake can surface the response; other callers retain bounded backoff.
      if (response.retryAfterMs !== undefined) {
        if (!retryRateLimit) return response;
        rateLimitSignatures.push(`rate-limit-${response.status}`);
        if (transientFixedPointReached(rateLimitSignatures)) {
          throw new GitHubOutageError(`rate-limit-${response.status}`, rateLimitSignatures.length - 1);
        }
        await this.sleep(response.retryBackoffMs ?? response.retryAfterMs);
        continue;
      }
      // A non-rate-limit 403 may be an expired installation token: force-mint once.
      if (response.status === 403 && input.refreshToken !== undefined && !refreshed) {
        refreshed = true;
        token = await input.refreshToken();
        continue;
      }
      // Transient gateways retry while structurally progressing; non-idempotent writes opt out.
      if (retryTransient && isTransientStatus(response.status)) {
        transientSignatures.push(`http-${response.status}`);
        if (transientFixedPointReached(transientSignatures)) {
          throw new GitHubOutageError(`http-${response.status}`, transientSignatures.length - 1);
        }
        await this.sleep(transientBackoffMs(transientSignatures.length - 1));
        continue;
      }
      return response;
    }
  }

  private async send(
    path: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    token: string,
    body: unknown,
  ): Promise<GitHubHttpResponse> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const responseBody = text === "" ? undefined : JSON.parse(text);
    const getHeader = headerGetter(response.headers);
    const retryBackoffMs = rateLimitBackoffMs(response.status, getHeader, this.now(), responseBody);
    const retryAfterHeader = getHeader("retry-after");
    const retryAfterSeconds =
      retryAfterHeader === null || retryAfterHeader.trim() === "" ? NaN : Number(retryAfterHeader);
    const exactRetryAfterMs =
      (response.status === 403 || response.status === 429) &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds >= 0
        ? Math.max(1_000, Math.ceil(retryAfterSeconds * 1_000))
        : retryBackoffMs;
    return {
      status: response.status,
      body: responseBody,
      retryAfterMs: exactRetryAfterMs,
      retryBackoffMs,
      ...(response.status >= 400 && { errorDetail: buildErrorDetail(response.status, responseBody, getHeader) }),
    };
  }
}
