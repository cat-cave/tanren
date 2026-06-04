// Bug 1 (merge queue robust to infra errors): focused tests of GitHubVcsProvider's
// race-safe `resetRef` — exercised through the only public path that calls it,
// `buildIntegrationBranch` with NO ancestors (it reads the base SHA, then resets the
// ephemeral integration ref to it). A FAKE GitHubHttpClient (test fixture) scripts the
// /git/refs create + PATCH responses so we prove:
//   - POST-422 "Reference already exists" → PATCH 200 → OK (the idempotent rebuild);
//   - POST-422 with another message ("Object does not exist") → a typed transient throw
//     AFTER the bounded internal retry (the live racy 422 that does NOT self-heal here);
//   - POST-422 transient ONCE then 201 on retry → the internal retry self-heals → OK.
// The sleep seam is a no-op so the bounded backoff runs instantly.

import { describe, expect, it } from "vitest";
import { GitHubVcsProvider } from "../src/engine/providers/githubVcsProvider.js";
import { RefResetPermanentError, RefResetTransientError } from "../src/engine/providers/githubRefReset.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import type { BuildIntegrationBranchInput, ResolvedVcsToken } from "../src/engine/contracts/vcsProvider.js";

const TOKEN: ResolvedVcsToken = { token: "t", source: "static", refresh: async () => "t2" };
const BASE_SHA = "0000baseref0000";

/** A scripted GitHub HTTP client: a queue of responses per (method + path-prefix) key. */
class ScriptedHttp implements GitHubHttpClient {
  readonly calls: Array<{ method: string; path: string }> = [];
  private readonly scripts = new Map<string, GitHubHttpResponse[]>();

  on(method: string, pathIncludes: string, ...responses: GitHubHttpResponse[]): this {
    this.scripts.set(`${method} ${pathIncludes}`, responses);
    return this;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.calls.push({ method: input.method, path: input.path });
    for (const [key, responses] of this.scripts) {
      const [method, includes] = key.split(" ", 2) as [string, string];
      if (input.method === method && input.path.includes(includes)) {
        // Consume responses in order; once one remains, REPEAT it (a persistent error).
        const next = responses.length > 1 ? responses.shift() : responses[0];
        if (next !== undefined) return next;
      }
    }
    throw new Error(`unscripted request: ${input.method} ${input.path}`);
  }
}

function buildInput(): BuildIntegrationBranchInput {
  return {
    repo: { owner: "cat-cave", name: "apex" },
    token: TOKEN,
    baseBranch: "main",
    integrationBranch: "tanren/batch/spec_x",
    // No ancestors → resetRef is the whole operation.
    ancestors: [],
  };
}

/** A provider with a no-op sleep so the bounded internal ref-reset retries run instantly. */
function makeProvider(http: GitHubHttpClient): GitHubVcsProvider {
  return new GitHubVcsProvider(http, { sleep: () => Promise.resolve() });
}

describe("GitHubVcsProvider.resetRef — race-safe + 422 classification (Bug 1)", () => {
  it("POST-422 'Reference already exists' → force-PATCH 200 → OK (idempotent rebuild)", async () => {
    const http = new ScriptedHttp()
      .on("GET", "/git/ref/heads/main", { status: 200, body: { object: { sha: BASE_SHA } } })
      .on("POST", "/git/refs", { status: 422, body: { message: "Reference already exists" } })
      .on("PATCH", "/git/refs/heads/", { status: 200, body: { object: { sha: BASE_SHA } } });

    const result = await makeProvider(http).buildIntegrationBranch(buildInput());

    expect(result.outcome).toBe("integrated");
    // It did the create then the force-PATCH (exactly once — no needless retry).
    expect(http.calls.filter((c) => c.method === "POST" && c.path.includes("/git/refs")).length).toBe(1);
    expect(http.calls.filter((c) => c.method === "PATCH").length).toBe(1);
  });

  it("POST-422 'Object does not exist' → typed transient throw AFTER the bounded retry", async () => {
    const http = new ScriptedHttp()
      .on("GET", "/git/ref/heads/main", { status: 200, body: { object: { sha: BASE_SHA } } })
      // Every create attempt returns the racy 422 with a NON-'already exists' message.
      .on("POST", "/git/refs", { status: 422, body: { message: "Object does not exist" } });

    await expect(makeProvider(http).buildIntegrationBranch(buildInput())).rejects.toBeInstanceOf(
      RefResetTransientError,
    );
    // It RETRIED the create (bounded) before surfacing — 3 attempts (initial + 2 retries).
    expect(http.calls.filter((c) => c.method === "POST" && c.path.includes("/git/refs")).length).toBe(3);
  });

  it("POST-422 transient ONCE then 201 → the internal retry self-heals → OK", async () => {
    const http = new ScriptedHttp()
      .on("GET", "/git/ref/heads/main", { status: 200, body: { object: { sha: BASE_SHA } } })
      // First create: racy transient 422; second create: success.
      .on(
        "POST",
        "/git/refs",
        { status: 422, body: { message: "Object does not exist" } },
        { status: 201, body: { ref: "refs/heads/tanren/batch/spec_x" } },
      );

    const result = await makeProvider(http).buildIntegrationBranch(buildInput());

    expect(result.outcome).toBe("integrated");
    // The create was attempted twice (the transient, then the success) — self-healed.
    expect(http.calls.filter((c) => c.method === "POST" && c.path.includes("/git/refs")).length).toBe(2);
  });

  // GitHub-5xx resilience: a raw 5xx reaching the ref-reset (defense-in-depth — the
  // HTTP client already retries these) must map to the RETRIABLE transient error, NOT a
  // permanent block. The live repro was a 504 on the `/git/refs` force-update.
  it("CREATE 5xx (504) → typed TRANSIENT throw (retried bounded), never permanent", async () => {
    const http = new ScriptedHttp()
      .on("GET", "/git/ref/heads/main", { status: 200, body: { object: { sha: BASE_SHA } } })
      // Every create attempt returns a raw 504 gateway timeout.
      .on("POST", "/git/refs", { status: 504, body: { message: "Gateway Timeout" } });

    await expect(makeProvider(http).buildIntegrationBranch(buildInput())).rejects.toBeInstanceOf(
      RefResetTransientError,
    );
    // Bounded retry of the create before surfacing (initial + 2 retries).
    expect(http.calls.filter((c) => c.method === "POST" && c.path.includes("/git/refs")).length).toBe(3);
  });

  it("force-PATCH 5xx (504) on the live repro path → typed TRANSIENT throw, never permanent", async () => {
    const http = new ScriptedHttp()
      .on("GET", "/git/ref/heads/main", { status: 200, body: { object: { sha: BASE_SHA } } })
      // Create collides (expected) → force-PATCH, which 504s every attempt.
      .on("POST", "/git/refs", { status: 422, body: { message: "Reference already exists" } })
      .on("PATCH", "/git/refs/heads/", { status: 504, body: { message: "Gateway Timeout" } });

    await expect(makeProvider(http).buildIntegrationBranch(buildInput())).rejects.toBeInstanceOf(
      RefResetTransientError,
    );
    // The whole create→force-PATCH retried (bounded) — three PATCH attempts.
    expect(http.calls.filter((c) => c.method === "PATCH").length).toBe(3);
  });
});

// GAP #2 (merge hardening): `refSha` + `mergeBranchInto` must throw the TYPED
// RefResetPermanentError (retriable: false) on a PERMANENT status (a 404 deleted/renamed
// ancestor branch, a 403) — NOT an untyped Error that the merge coordinator's
// `isRetriableInfraError` defaults to retriable → the 3s infra re-drive loop forever. A
// transient 5xx stays the RETRIABLE typed error. The 409-on-/merges conflict path is
// untouched (a conflict is NOT an infra error).
describe("GitHubVcsProvider — typed PERMANENT vs TRANSIENT on refSha / mergeBranchInto (GAP #2)", () => {
  function buildInputWithAncestor() {
    return { ...buildInput(), ancestors: [{ specId: "spec_anc", branch: "feat-anc" }] };
  }

  it("refSha 404 (base branch gone) → RefResetPermanentError (not retriable, holds-loud-once)", async () => {
    const http = new ScriptedHttp().on("GET", "/git/ref/heads/main", {
      status: 404,
      body: { message: "Not Found" },
    });
    await expect(makeProvider(http).buildIntegrationBranch(buildInput())).rejects.toBeInstanceOf(
      RefResetPermanentError,
    );
    // It read the ref ONCE — no infinite re-read (the permanent status is terminal here).
    expect(http.calls.filter((c) => c.method === "GET").length).toBe(1);
  });

  it("refSha 5xx (504) on the base read → RefResetTransientError (a genuine gateway blip)", async () => {
    const http = new ScriptedHttp().on("GET", "/git/ref/heads/main", {
      status: 504,
      body: { message: "Gateway Timeout" },
    });
    await expect(makeProvider(http).buildIntegrationBranch(buildInput())).rejects.toBeInstanceOf(
      RefResetTransientError,
    );
  });

  it("refSha 404 on an ANCESTOR branch (deleted/renamed mid-batch) → RefResetPermanentError", async () => {
    const http = new ScriptedHttp()
      .on("GET", "/git/ref/heads/main", { status: 200, body: { object: { sha: BASE_SHA } } })
      .on("POST", "/git/refs", { status: 201, body: { ref: "refs/heads/tanren/batch/spec_x" } })
      // The ancestor branch ref read 404s — it was deleted/renamed after the batch formed.
      .on("GET", "/git/ref/heads/feat-anc", { status: 404, body: { message: "Not Found" } });
    await expect(makeProvider(http).buildIntegrationBranch(buildInputWithAncestor())).rejects.toBeInstanceOf(
      RefResetPermanentError,
    );
  });

  it("mergeBranchInto 404 (head/base gone) → RefResetPermanentError; 409 stays a conflict (unchanged)", async () => {
    const okBase = new ScriptedHttp()
      .on("GET", "/git/ref/heads/main", { status: 200, body: { object: { sha: BASE_SHA } } })
      .on("POST", "/git/refs", { status: 201, body: { ref: "refs/heads/tanren/batch/spec_x" } })
      .on("GET", "/git/ref/heads/feat-anc", { status: 200, body: { object: { sha: "ancSha" } } });

    // A 404 from POST /merges (the head branch vanished) → typed PERMANENT, never retriable.
    const http404 = new ScriptedHttp()
      .on("GET", "/git/ref/heads/main", { status: 200, body: { object: { sha: BASE_SHA } } })
      .on("POST", "/git/refs", { status: 201, body: { ref: "refs/heads/tanren/batch/spec_x" } })
      .on("GET", "/git/ref/heads/feat-anc", { status: 200, body: { object: { sha: "ancSha" } } })
      .on("POST", "/merges", { status: 404, body: { message: "Not Found" } });
    await expect(makeProvider(http404).buildIntegrationBranch(buildInputWithAncestor())).rejects.toBeInstanceOf(
      RefResetPermanentError,
    );

    // The 409 conflict path is UNCHANGED: a genuine conflict resolves to outcome
    // `conflict` (NOT an infra error, NOT a throw).
    const http409 = okBase.on("POST", "/merges", { status: 409, body: { message: "Merge conflict" } });
    const result = await makeProvider(http409).buildIntegrationBranch(buildInputWithAncestor());
    expect(result.outcome).toBe("conflict");
  });
});
