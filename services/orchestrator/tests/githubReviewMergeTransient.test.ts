// GitHub-5xx resilience (merge double-merge guard): the merge `PUT` is non-idempotent —
// a 504 on it may have ALREADY merged the PR server-side. These prove
// GitHubReviewMergeService.mergePullRequest:
//   - opts OUT of the client's blind transient retry on the PUT (retryTransient:false);
//   - on a transient 5xx RE-READS `GET /pulls/{n}`: if `merged`, returns success (the
//     504 raced a completed merge — never blindly re-PUTs / double-merges);
//   - if still open + unmerged, re-PUTs (bounded), then succeeds;
//   - persistent transient WHEN confirmed open+unmerged → THROWS MergeTransientError
//     (GAP #2d — retriable, routed to an infra-hold, not a terminal merge.failed);
//   - AMBIGUOUS (reconcile read unconfirmable) → THROWS MergeAmbiguousError (loud,
//     non-auto-retry — never re-PUTs / double-merges);
//   - keeps the normal 200 / 405-conflict paths unchanged.

import { describe, expect, it } from "vitest";
import type { GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { GitHubReviewMergeService } from "../src/engine/providers/githubReviewMerge.js";
import { MergeAmbiguousError, MergeTransientError } from "../src/engine/providers/mergeOutcomeErrors.js";

/** A scripted HTTP client: a queue of responses per `${method} ${pathIncludes}` key. */
class ScriptedHttp {
  readonly calls: GitHubHttpRequest[] = [];
  private readonly scripts = new Map<string, GitHubHttpResponse[]>();

  on(method: string, pathIncludes: string, ...responses: GitHubHttpResponse[]): this {
    this.scripts.set(`${method} ${pathIncludes}`, responses);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.calls.push(input);
    for (const [key, responses] of this.scripts) {
      const [method, includes] = key.split(" ", 2) as [string, string];
      // The merge PUT path and the GET path both include `/pulls/{n}` — disambiguate the
      // PUT by its `/merge` suffix so a `GET /pulls/{n}` never matches the PUT script.
      if (input.method !== method) continue;
      if (!input.path.includes(includes)) continue;
      if (method === "GET" && input.path.endsWith("/merge")) continue;
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next !== undefined) return next;
    }
    throw new Error(`unscripted request: ${input.method} ${input.path}`);
  }

  countOf(method: string, pathSuffix: string): number {
    return this.calls.filter((c) => c.method === method && c.path.endsWith(pathSuffix)).length;
  }
}

const REPO = { owner: "cat-cave", name: "apex" };

describe("mergePullRequest — happy path + genuine conflict (unchanged)", () => {
  it("returns merged on a 200", async () => {
    const http = new ScriptedHttp().on("PUT", "/merge", {
      status: 200,
      body: { sha: "0badf00d", merged: true },
    });
    const result = await new GitHubReviewMergeService(http).mergePullRequest({
      repo: REPO,
      pullNumber: 7,
      token: "t",
    });
    expect(result).toMatchObject({ merged: true, conflict: false, status: 200 });
    // The PUT opts out of blind transient retry (the guard reconciles instead).
    expect(http.calls[0]?.retryTransient).toBe(false);
  });

  it("returns a conflict on a 405 (real un-mergeable state) — no re-read", async () => {
    const http = new ScriptedHttp().on("PUT", "/merge", {
      status: 405,
      body: { message: "Pull Request is not mergeable" },
    });
    const result = await new GitHubReviewMergeService(http).mergePullRequest({
      repo: REPO,
      pullNumber: 8,
      token: "t",
    });
    expect(result).toMatchObject({ merged: false, conflict: true, status: 405 });
    // A genuine 405 never triggers the reconciliation GET.
    expect(http.countOf("GET", "/pulls/8")).toBe(0);
  });
});

describe("mergePullRequest — double-merge guard on a transient 504", () => {
  it("504 on PUT but the PR actually merged → returns success (never re-PUTs)", async () => {
    const http = new ScriptedHttp()
      .on("PUT", "/merge", { status: 504, body: { message: "Gateway Timeout" } })
      // The reconciliation read shows the merge DID land (the 504 raced a completed merge).
      .on("GET", "/pulls/9", { status: 200, body: { merged: true, state: "closed", merge_commit_sha: "1a2b3c4d" } });

    const result = await new GitHubReviewMergeService(http).mergePullRequest({
      repo: REPO,
      pullNumber: 9,
      token: "t",
    });

    expect(result).toMatchObject({ merged: true, conflict: false, status: 200, mergeSha: "1a2b3c4d" });
    // Exactly ONE PUT — the guard never blindly re-PUTs an already-merged PR.
    expect(http.countOf("PUT", "/pulls/9/merge")).toBe(1);
    expect(http.countOf("GET", "/pulls/9")).toBe(1);
  });

  it("504 on PUT, PR still open + unmerged → re-PUTs (bounded) then merges", async () => {
    const http = new ScriptedHttp()
      // First PUT 504, second PUT succeeds.
      .on(
        "PUT",
        "/merge",
        { status: 504, body: { message: "Gateway Timeout" } },
        { status: 200, body: { sha: "0c0ffee0", merged: true } },
      )
      // The reconciliation read after the 504 shows still open + not merged → safe to re-PUT.
      .on("GET", "/pulls/10", { status: 200, body: { merged: false, state: "open" } });

    const result = await new GitHubReviewMergeService(http).mergePullRequest({
      repo: REPO,
      pullNumber: 10,
      token: "t",
    });

    expect(result).toMatchObject({ merged: true, conflict: false, status: 200 });
    // Two PUTs (the 504, then the successful re-PUT), one reconciliation GET.
    expect(http.countOf("PUT", "/pulls/10/merge")).toBe(2);
    expect(http.countOf("GET", "/pulls/10")).toBe(1);
  });

  it("persistent 504, PR confirmed open+unmerged after the ceiling → THROWS MergeTransientError (GAP #2d)", async () => {
    const http = new ScriptedHttp()
      .on("PUT", "/merge", { status: 504, body: { message: "Gateway Timeout" } })
      // Each re-check POSITIVELY confirms still open + not merged, so it re-PUTs up to
      // the ceiling, then throws the typed transient (retriable → infra-hold, not failed).
      .on("GET", "/pulls/11", { status: 200, body: { merged: false, state: "open" } });

    const service = new GitHubReviewMergeService(http);
    await expect(service.mergePullRequest({ repo: REPO, pullNumber: 11, token: "t" })).rejects.toBeInstanceOf(
      MergeTransientError,
    );
    // Bounded: the initial PUT + MERGE_TRANSIENT_RETRIES (2) re-PUTs = 3 total.
    expect(http.countOf("PUT", "/pulls/11/merge")).toBe(3);
  });

  it("504 on PUT and the reconciliation read ALSO fails → THROWS MergeAmbiguousError (no blind re-PUT)", async () => {
    const http = new ScriptedHttp()
      .on("PUT", "/merge", { status: 504, body: { message: "Gateway Timeout" } })
      // The reconciliation read ALSO fails — UNCONFIRMABLE; the guard refuses to guess.
      .on("GET", "/pulls/12", { status: 502, body: { message: "Bad Gateway" } });

    const service = new GitHubReviewMergeService(http);
    await expect(service.mergePullRequest({ repo: REPO, pullNumber: 12, token: "t" })).rejects.toBeInstanceOf(
      MergeAmbiguousError,
    );
    // Only the ONE PUT — an unconfirmed state is never re-PUT (could double-merge).
    expect(http.countOf("PUT", "/pulls/12/merge")).toBe(1);
  });

  it("504 on PUT, the PR is closed-but-unmerged (neither merged nor open) → AMBIGUOUS throw (no re-PUT)", async () => {
    const http = new ScriptedHttp()
      .on("PUT", "/merge", { status: 504, body: { message: "Gateway Timeout" } })
      // Reconcile read SUCCEEDS but the PR is neither confirmed-merged NOR open (e.g.
      // closed-without-merge) — still ambiguous; we will not guess (re-PUT could mis-act).
      .on("GET", "/pulls/13", { status: 200, body: { merged: false, state: "closed" } });

    const service = new GitHubReviewMergeService(http);
    await expect(service.mergePullRequest({ repo: REPO, pullNumber: 13, token: "t" })).rejects.toBeInstanceOf(
      MergeAmbiguousError,
    );
    expect(http.countOf("PUT", "/pulls/13/merge")).toBe(1);
  });
});
