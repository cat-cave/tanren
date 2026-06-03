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
import { RefResetTransientError } from "../src/engine/providers/githubRefReset.js";
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
});
