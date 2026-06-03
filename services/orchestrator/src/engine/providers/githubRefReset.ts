// Bug 1 (merge queue robust to infra errors): the race-safe GitHub integration-ref
// reset, extracted from GitHubVcsProvider so the provider stays under its line cap and
// the typed infra errors + classification live in one focused module.
//
// GitHub's git database can transiently reject a ref op with an HTTP 422 that
// self-heals on an immediate retry (the live apex repro: a clean scaffold PR's batch
// check threw `ref reset failed ... HTTP 422`, yet the SAME ref ops succeeded on
// re-attempt). So `resetRef`:
//   - branches on the response BODY message (not just `.status`): a 422 whose message
//     says "already exists" is the EXPECTED create-collision → proceed to the force
//     PATCH (now justified, not assumed); any OTHER 422 is a transient git-db state;
//   - bounds an INTERNAL retry (a few attempts, short backoff via an injected sleep)
//     around the whole create→force-PATCH so a transient 422 self-heals at this layer
//     (KEEPS create→force-PATCH — never delete-then-create, which widens a 404 window);
//   - on exhaustion throws the typed `RefResetTransientError` so the batch coordinator
//     maps it to the `infra-error` verdict (retriable) → bounded retry + LOUD hold,
//     never a wrong dequeue of a clean PR.

import type { RepoRef, ResolvedVcsToken } from "../contracts/vcsProvider.js";
import type { GitHubHttpClient } from "./github.js";

function repoApiPath(repo: RepoRef, suffix: string): string {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
}

/**
 * A TRANSIENT infra error setting up a forge operation (e.g. a git-ref reset that hit
 * a racy HTTP 422 on GitHub's git database). It means the operation could not be RUN —
 * it is NOT a CI failure and NOT a merge conflict. The batch coordinator maps this to
 * the `infra-error` verdict (retriable: true) so a clean PR is HELD + retried, never
 * dequeued/blamed. The live repro shows the SAME ref op succeeds on immediate retry.
 */
export class RefResetTransientError extends Error {
  /** Always retriable — the operation should self-heal on a re-attempt. */
  readonly retriable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "RefResetTransientError";
  }
}

/**
 * A PERMANENT infra error setting up a forge operation (e.g. a ref reset rejected for
 * a reason that will not self-heal). It is STILL an infra error (the check could not be
 * run) — the coordinator HOLDS rather than dequeues — but it is NOT worth retrying, so
 * the coordinator skips its retry budget and surfaces the loud hold immediately.
 */
export class RefResetPermanentError extends Error {
  readonly retriable = false as const;
  constructor(message: string) {
    super(message);
    this.name = "RefResetPermanentError";
  }
}

/**
 * True iff `error` is a typed infra error from the provider layer that is RETRIABLE
 * (a transient transport/ref error). The batch coordinator uses this to set the
 * `infra-error` verdict's `retriable` flag accurately: a typed transient → retriable;
 * a typed permanent infra error → not. An UNTYPED thrown value defaults to retriable:
 * the live repro is a transient git-db 422, and a bounded retry then loud hold is safe
 * (it never dequeues); permanence is only asserted via the typed permanent error.
 */
export function isRetriableInfraError(error: unknown): boolean {
  if (error instanceof RefResetTransientError) return true;
  if (error instanceof RefResetPermanentError) return false;
  return true;
}

/** Extract GitHub's `{message}` from a parsed JSON response body, if present. */
function bodyMessage(body: unknown): string {
  if (typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string") {
    return (body as { message: string }).message;
  }
  return "";
}

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [200, 400];

/**
 * (Re)set the ephemeral integration ref to `sha`: create it, or force-update it if it
 * already exists — with the body-message classification + bounded internal retry above.
 * `sleep` is injected so tests run the bounded backoff instantly.
 */
export async function resetRef(args: {
  http: GitHubHttpClient;
  sleep: (ms: number) => Promise<void>;
  repo: RepoRef;
  token: ResolvedVcsToken;
  branch: string;
  sha: string;
}): Promise<void> {
  let lastTransient: RefResetTransientError | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      await resetRefOnce(args);
      return;
    } catch (error) {
      if (error instanceof RefResetTransientError) {
        lastTransient = error;
        // Bounded backoff between attempts; the next iteration re-tries create→PATCH.
        if (attempt < MAX_ATTEMPTS - 1) await args.sleep(BACKOFF_MS[attempt] ?? 400);
        continue;
      }
      // A permanent infra error or a non-ref error: surface immediately (no retry).
      throw error;
    }
  }
  // Retries exhausted on a transient error — surface it typed so the coordinator
  // classifies the verdict as a (retriable) infra-error + holds loudly.
  throw (
    lastTransient ?? new RefResetTransientError(`GitHub integration ref reset for ${args.branch} exhausted retries`)
  );
}

/** A single create→(on-exists)force-PATCH attempt; classifies 422s by body message. */
async function resetRefOnce(args: {
  http: GitHubHttpClient;
  repo: RepoRef;
  token: ResolvedVcsToken;
  branch: string;
  sha: string;
}): Promise<void> {
  const { http, repo, token, branch, sha } = args;
  const create = await http.request({
    method: "POST",
    path: repoApiPath(repo, "/git/refs"),
    token: token.token,
    refreshToken: token.refresh,
    body: { ref: `refs/heads/${branch}`, sha },
  });
  if (create.status === 201) {
    return;
  }
  if (create.status === 422) {
    const message = bodyMessage(create.body);
    // "Reference already exists" → the EXPECTED create-collision; force it back to the
    // base sha (idempotent rebuild). Any OTHER 422 (e.g. "Object does not exist" — a
    // racy git-db read) is TRANSIENT, not a permanent failure.
    if (!/already exists/iu.test(message)) {
      throw new RefResetTransientError(
        `GitHub integration ref create for ${branch} hit a transient HTTP 422: ${message || "(no message)"}`,
      );
    }
    const update = await http.request({
      method: "PATCH",
      path: repoApiPath(repo, `/git/refs/heads/${encodeURIComponent(branch)}`),
      token: token.token,
      refreshToken: token.refresh,
      body: { sha, force: true },
    });
    if (update.status === 200) {
      return;
    }
    // The force-update did not take. A "does not exist"/"cannot be updated"/422 is a
    // transient ref-state race (retry self-heals); anything else is permanent.
    const updateMessage = bodyMessage(update.body);
    if (update.status === 422 || /does not exist|cannot be updated/iu.test(updateMessage)) {
      throw new RefResetTransientError(
        `GitHub integration ref force-update for ${branch} hit a transient HTTP ${update.status}: ${updateMessage || "(no message)"}`,
      );
    }
    throw new RefResetPermanentError(
      `GitHub integration ref force-update for ${branch} failed: HTTP ${update.status}: ${updateMessage || "(no message)"}`,
    );
  }
  throw new RefResetPermanentError(
    `GitHub integration ref create for ${branch} failed: HTTP ${create.status}: ${bodyMessage(create.body) || "(no message)"}`,
  );
}
