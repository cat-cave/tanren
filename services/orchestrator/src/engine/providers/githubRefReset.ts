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
import { isTransientStatus } from "./githubRetry.js";

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
 * True iff `error` is a RETRIABLE infra error from the provider layer (a transient
 * transport/ref/merge error). Structural by design — it reads the typed errors'
 * readonly `retriable` flag rather than enumerating classes, so the ref-reset transients
 * (`RefResetTransientError`) AND the merge-PUT transients (`MergeTransientError`) both
 * route to the coordinator's infra-hold, while the typed PERMANENT/AMBIGUOUS errors
 * (`retriable: false`) do not. The batch coordinator uses it for the `infra-error`
 * verdict's `retriable` flag; the per-PR coordinator uses it to choose hold-vs-halt.
 *
 * An UNTYPED thrown value defaults to RETRIABLE: the live repros are transient (a git-db
 * 422, a gateway 504), and a bounded hold-then-loud-ceiling is safe (it never strands,
 * and the hold-attempt ceiling stops an untyped error from looping forever). Permanence
 * is only asserted via a typed `retriable: false`.
 */
export function isRetriableInfraError(error: unknown): boolean {
  if (error instanceof Error) {
    const flag = (error as { retriable?: unknown }).retriable;
    if (typeof flag === "boolean") return flag;
  }
  return true;
}

/**
 * Classify a non-OK status from a speculative-integration forge read (a ref read / a
 * `/merges` call) into the TYPED infra error `isRetriableInfraError` reads. A transient
 * gateway status (502/503/504/408) is `RefResetTransientError` (retriable: true → a
 * bounded re-drive self-heals); ANY other status — a 404 (a deleted/renamed ancestor
 * branch), a 403 (auth/permission), a 422, etc. — is `RefResetPermanentError`
 * (retriable: false → the batch holds loud-ONCE then the per-batch ceiling escalates,
 * instead of re-driving the 3s infra loop forever on a missing branch).
 */
export function refReadStatusError(op: string, subject: string, status: number): Error {
  const detail = `GitHub ${op} for ${subject} failed: HTTP ${status}`;
  return isTransientStatus(status) ? new RefResetTransientError(detail) : new RefResetPermanentError(detail);
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
    // transient ref-state race (retry self-heals); a 5xx gateway timeout (502/503/504/
    // 408 — the live 504 repro) is ALSO transient (the HTTP client already retried it;
    // a raw one reaching here must still self-heal, not be misclassified permanent);
    // anything else is permanent.
    const updateMessage = bodyMessage(update.body);
    if (
      update.status === 422 ||
      isTransientStatus(update.status) ||
      /does not exist|cannot be updated/iu.test(updateMessage)
    ) {
      throw new RefResetTransientError(
        `GitHub integration ref force-update for ${branch} hit a transient HTTP ${update.status}: ${updateMessage || "(no message)"}`,
      );
    }
    throw new RefResetPermanentError(
      `GitHub integration ref force-update for ${branch} failed: HTTP ${update.status}: ${updateMessage || "(no message)"}`,
    );
  }
  // A 5xx gateway failure on the CREATE (502/503/504/408) is transient → retry, never a
  // permanent block (defense-in-depth: the HTTP client already retries these).
  if (isTransientStatus(create.status)) {
    throw new RefResetTransientError(
      `GitHub integration ref create for ${branch} hit a transient HTTP ${create.status}: ${bodyMessage(create.body) || "(no message)"}`,
    );
  }
  throw new RefResetPermanentError(
    `GitHub integration ref create for ${branch} failed: HTTP ${create.status}: ${bodyMessage(create.body) || "(no message)"}`,
  );
}
